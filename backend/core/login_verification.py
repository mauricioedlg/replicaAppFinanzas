"""Browser-bound, single-use email codes before establishing app sessions."""

import math
import secrets
import uuid
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone
from django.utils.crypto import constant_time_compare, salted_hmac
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_protect
from rest_framework import serializers, status
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle
from rest_framework.views import APIView

from .emails import EmailDeliveryError, ensure_email_configured, send_login_verification_code
from .models import LoginChallenge
from .serializers import UserSerializer
from .session_authentication import establish_verified_session

User = get_user_model()
CODE_TTL_SECONDS = 600
MAX_CODE_ATTEMPTS = 5
RESEND_COOLDOWN_SECONDS = 60
MAX_SENDS_PER_HOUR = 5
NONCE_SESSION_KEY = "login_verification_nonce"
INVALID_CODE_DETAIL = "El código es inválido o ha vencido. Solicita uno nuevo e inténtalo de nuevo."
DELIVERY_ERROR_DETAIL = "No pudimos enviar el código de acceso. Inténtalo de nuevo más tarde."


class LoginVerificationRateLimit(Exception):
    def __init__(self, retry_after):
        self.retry_after = max(1, int(retry_after))


def rate_limit_response(error):
    return Response(
        {"detail": "Espera antes de solicitar otro código de acceso.", "retry_after": error.retry_after},
        status=status.HTTP_429_TOO_MANY_REQUESTS,
        headers={"Retry-After": str(error.retry_after)},
    )


def _digest(purpose, challenge_id, value):
    return salted_hmac(f"folio.login-verification.{purpose}", f"{challenge_id}:{value}", algorithm="sha256").hexdigest()


def _fingerprint(user):
    return salted_hmac("folio.login-verification.password", user.password, algorithm="sha256").hexdigest()


def _browser_matches(request, challenge):
    nonce = request.session.get(NONCE_SESSION_KEY, "")
    return bool(nonce) and constant_time_compare(challenge.browser_digest, _digest("browser", challenge.challenge_id, nonce))


def _account_matches(user, challenge):
    return (
        user.is_active and user.has_usable_password()
        and user.email.casefold() == challenge.email.casefold()
        and constant_time_compare(challenge.password_fingerprint, _fingerprint(user))
    )


def _pending(challenge, now):
    return (
        challenge.consumed_at is None and bool(challenge.code_digest)
        and challenge.attempts < MAX_CODE_ATTEMPTS and challenge.expires_at > now
    )


def _metadata(challenge, now):
    local, domain = challenge.email.rsplit("@", 1)
    hint = local[:2] + "***@" + domain
    return {
        "verification_required": True,
        "challenge_id": str(challenge.challenge_id),
        "email_hint": hint,
        "detail": "Te enviamos un código por correo. Verifícalo para iniciar sesión.",
        "expires_in": max(0, math.ceil((challenge.expires_at - now).total_seconds())),
        "retry_after": max(0, math.ceil((challenge.sent_at + timedelta(seconds=RESEND_COOLDOWN_SECONDS) - now).total_seconds())),
    }


def _send_challenge(request, user, challenge, now):
    """Account is locked by caller; provider errors roll back both code and budget."""
    window_active = challenge is not None and challenge.send_window_started_at > now - timedelta(hours=1)
    if window_active and challenge.send_count >= MAX_SENDS_PER_HOUR:
        raise LoginVerificationRateLimit(math.ceil((challenge.send_window_started_at + timedelta(hours=1) - now).total_seconds()))
    if challenge is not None and challenge.sent_at > now - timedelta(seconds=RESEND_COOLDOWN_SECONDS):
        raise LoginVerificationRateLimit(math.ceil((challenge.sent_at + timedelta(seconds=RESEND_COOLDOWN_SECONDS) - now).total_seconds()))
    nonce = request.session.get(NONCE_SESSION_KEY)
    if not nonce:
        nonce = secrets.token_urlsafe(32)
        request.session[NONCE_SESSION_KEY] = nonce
    if challenge is None:
        challenge = LoginChallenge(user=user)
    challenge.challenge_id = uuid.uuid4()
    challenge.email = user.email
    challenge.password_fingerprint = _fingerprint(user)
    challenge.browser_digest = _digest("browser", challenge.challenge_id, nonce)
    code = f"{secrets.randbelow(1_000_000):06d}"
    challenge.code_digest = _digest("code", challenge.challenge_id, code)
    challenge.expires_at = now + timedelta(seconds=CODE_TTL_SECONDS)
    challenge.consumed_at = None
    challenge.attempts = 0
    challenge.sent_at = now
    if not window_active:
        challenge.send_window_started_at = now
        challenge.send_count = 0
    challenge.send_count += 1
    challenge.save()
    # SessionMiddleware saves the browser nonce after this transaction commits.
    # Saving a new session inside a transaction that later rolls back on a mail
    # failure would leave SessionMiddleware updating a nonexistent session row.
    send_login_verification_code(user, code, challenge_id=challenge.challenge_id)
    return _metadata(challenge, now)


def begin_login_verification(request, authenticated_user):
    ensure_email_configured()
    now = timezone.now()
    with transaction.atomic():
        user = User.objects.select_for_update().get(pk=authenticated_user.pk)
        # Credentials can change between authenticate() and obtaining this lock.
        if not user.is_active or not user.has_usable_password() or not constant_time_compare(user.password, authenticated_user.password):
            raise ValidationError({"detail": "El usuario o la contraseña son incorrectos."})
        challenge = LoginChallenge.objects.select_for_update().filter(user=user).first()
        if challenge is not None and _pending(challenge, now) and _account_matches(user, challenge) and _browser_matches(request, challenge):
            # A retry of the credentials request must not dispatch a duplicate code.
            return _metadata(challenge, now)
        return _send_challenge(request, user, challenge, now)


class ChallengeSerializer(serializers.Serializer):
    challenge_id = serializers.UUIDField()


class VerifySerializer(ChallengeSerializer):
    code = serializers.RegexField(r"^[0-9]{6}$", min_length=6, max_length=6, trim_whitespace=False, write_only=True)


class LoginVerificationThrottle(SimpleRateThrottle):
    scope = "login_verify"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}


class LoginResendThrottle(LoginVerificationThrottle):
    scope = "login_resend"


def _locked_challenge(challenge_id):
    # Resolve first without a lock, then always lock account before challenge.
    user_id = LoginChallenge.objects.filter(challenge_id=challenge_id).values_list("user_id", flat=True).first()
    if user_id is None:
        return None, None
    user = User.objects.select_for_update().filter(pk=user_id).first()
    challenge = LoginChallenge.objects.select_for_update().filter(user=user, challenge_id=challenge_id).first()
    return user, challenge


@method_decorator(csrf_protect, name="dispatch")
class LoginVerificationView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [LoginVerificationThrottle]

    def post(self, request):
        serializer = VerifySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        now = timezone.now()
        verified_user = None
        with transaction.atomic():
            user, challenge = _locked_challenge(data["challenge_id"])
            if user is not None and challenge is not None and _pending(challenge, now) and _account_matches(user, challenge) and _browser_matches(request, challenge):
                if constant_time_compare(challenge.code_digest, _digest("code", challenge.challenge_id, data["code"])):
                    challenge.consumed_at = now
                    challenge.code_digest = ""
                    challenge.save(update_fields=["consumed_at", "code_digest"])
                    establish_verified_session(request, user)
                    verified_user = user
                else:
                    challenge.attempts += 1
                    if challenge.attempts >= MAX_CODE_ATTEMPTS:
                        challenge.code_digest = ""
                    challenge.save(update_fields=["attempts", "code_digest"])
        if verified_user is None:
            return Response({"detail": INVALID_CODE_DETAIL}, status=status.HTTP_400_BAD_REQUEST)
        return Response({"user": UserSerializer(verified_user).data})


@method_decorator(csrf_protect, name="dispatch")
class LoginResendView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [LoginResendThrottle]

    def post(self, request):
        serializer = ChallengeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        now = timezone.now()
        try:
            with transaction.atomic():
                user, challenge = _locked_challenge(serializer.validated_data["challenge_id"])
                if user is None or challenge is None or challenge.consumed_at is not None or not _account_matches(user, challenge) or not _browser_matches(request, challenge):
                    return Response({"detail": INVALID_CODE_DETAIL}, status=status.HTTP_400_BAD_REQUEST)
                ensure_email_configured()
                result = _send_challenge(request, user, challenge, now)
        except LoginVerificationRateLimit as exc:
            return rate_limit_response(exc)
        except EmailDeliveryError:
            return Response({"detail": DELIVERY_ERROR_DETAIL}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        return Response(result)
