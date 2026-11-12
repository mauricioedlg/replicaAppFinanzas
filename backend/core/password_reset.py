"""Email/code/password recovery with durable, single-use server-side challenges."""

import logging
import secrets
import uuid
from datetime import timedelta

from django.contrib.auth import get_user_model, logout
from django.contrib.auth.password_validation import validate_password
from django.contrib.sessions.models import Session
from django.core.exceptions import ValidationError as DjangoValidationError
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

from .emails import EmailDeliveryError, ensure_email_configured, send_password_reset_code, send_password_reset_confirmation
from .models import PasswordResetChallenge

logger = logging.getLogger(__name__)
User = get_user_model()

CODE_TTL_SECONDS = 600
TOKEN_TTL_SECONDS = 300
MAX_CODE_ATTEMPTS = 5
RESEND_COOLDOWN_SECONDS = 60
MAX_REQUESTS_PER_HOUR = 5
REQUEST_DETAIL = "Si el correo está registrado, recibirás un código de verificación. Revisa también tu carpeta de spam."
INVALID_CODE_DETAIL = "El código es inválido o ha vencido. Solicita uno nuevo e inténtalo de nuevo."
INVALID_TOKEN_DETAIL = "La verificación es inválida o ha vencido. Solicita un nuevo código."
DELIVERY_ERROR_DETAIL = "La recuperación no está disponible en este momento. Inténtalo de nuevo más tarde."


def _digest(purpose, challenge_id, secret):
    return salted_hmac(f"folio.password-reset.{purpose}", f"{challenge_id}:{secret}", algorithm="sha256").hexdigest()


def _password_fingerprint(user):
    return salted_hmac("folio.password-reset.password", user.password, algorithm="sha256").hexdigest()


class ResetEmailSerializer(serializers.Serializer):
    email = serializers.EmailField(max_length=254)

    def validate_email(self, value):
        return value.strip().lower()


class ResetCodeSerializer(ResetEmailSerializer):
    challenge_id = serializers.UUIDField()
    code = serializers.RegexField(r"^[0-9]{6}$", min_length=6, max_length=6, trim_whitespace=False, write_only=True)


class ResetPasswordSerializer(ResetEmailSerializer):
    challenge_id = serializers.UUIDField()
    reset_token = serializers.CharField(min_length=32, max_length=128, trim_whitespace=False, write_only=True)
    password = serializers.CharField(max_length=128, trim_whitespace=False, write_only=True)
    confirm_password = serializers.CharField(max_length=128, trim_whitespace=False, write_only=True)

    def validate(self, attrs):
        if attrs["password"] != attrs["confirm_password"]:
            raise serializers.ValidationError({"confirm_password": ["Las contraseñas no coinciden."]})
        return attrs


class PasswordResetRequestThrottle(SimpleRateThrottle):
    scope = "password_reset_request"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}


class PasswordResetVerifyThrottle(PasswordResetRequestThrottle):
    scope = "password_reset_verify"


class PasswordResetConfirmThrottle(PasswordResetRequestThrottle):
    scope = "password_reset_confirm"


def _locked_user(email):
    # Always lock the account before its challenge, including when creating one.
    user = User.objects.select_for_update().filter(email__iexact=email, is_active=True).first()
    return user if user is not None and user.has_usable_password() else None


def _valid_challenge(user, challenge_id, email, now):
    if user is None:
        return None
    challenge = PasswordResetChallenge.objects.select_for_update().filter(user=user, challenge_id=challenge_id).first()
    if (
        challenge is None
        or challenge.consumed_at is not None
        or challenge.expires_at <= now
        or challenge.attempts >= MAX_CODE_ATTEMPTS
        or challenge.email.casefold() != email.casefold()
        or challenge.email.casefold() != user.email.casefold()
        or not constant_time_compare(challenge.password_fingerprint, _password_fingerprint(user))
    ):
        return None
    return challenge


@method_decorator(csrf_protect, name="dispatch")
class PasswordResetRequestView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [PasswordResetRequestThrottle]

    def post(self, request):
        serializer = ResetEmailSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data["email"]
        # A random decoy also covers inactive accounts and suppressed resend requests.
        response_id = uuid.uuid4()
        now = timezone.now()
        try:
            ensure_email_configured()
            with transaction.atomic():
                user = _locked_user(email)
                if user is not None:
                    challenge = PasswordResetChallenge.objects.select_for_update().filter(user=user).first()
                    window_active = challenge is not None and challenge.send_window_started_at > now - timedelta(hours=1)
                    cooldown = challenge is not None and challenge.sent_at > now - timedelta(seconds=RESEND_COOLDOWN_SECONDS)
                    quota_reached = window_active and challenge.send_count >= MAX_REQUESTS_PER_HOUR
                    if not cooldown and not quota_reached:
                        code = f"{secrets.randbelow(1_000_000):06d}"
                        if challenge is None:
                            challenge = PasswordResetChallenge(user=user)
                        challenge.challenge_id = response_id
                        challenge.email = email
                        challenge.password_fingerprint = _password_fingerprint(user)
                        challenge.code_digest = _digest("code", response_id, code)
                        challenge.reset_token_digest = ""
                        challenge.expires_at = now + timedelta(seconds=CODE_TTL_SECONDS)
                        challenge.verified_at = None
                        challenge.consumed_at = None
                        challenge.attempts = 0
                        challenge.sent_at = now
                        if not window_active:
                            challenge.send_window_started_at = now
                            challenge.send_count = 0
                        challenge.send_count += 1
                        challenge.save()
                        # A dispatch failure rolls back the new code, preserving any old valid one.
                        send_password_reset_code(user, code, challenge_id=response_id)
        except EmailDeliveryError:
            return Response({"detail": DELIVERY_ERROR_DETAIL}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        return Response({
            "detail": REQUEST_DETAIL,
            "challenge_id": str(response_id),
            "expires_in": CODE_TTL_SECONDS,
            "retry_after": RESEND_COOLDOWN_SECONDS,
        })


@method_decorator(csrf_protect, name="dispatch")
class PasswordResetVerifyView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [PasswordResetVerifyThrottle]

    def post(self, request):
        serializer = ResetCodeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        now = timezone.now()
        reset_token = None
        with transaction.atomic():
            user = _locked_user(data["email"])
            challenge = _valid_challenge(user, data["challenge_id"], data["email"], now)
            if challenge is not None and challenge.verified_at is None and challenge.code_digest:
                if constant_time_compare(challenge.code_digest, _digest("code", challenge.challenge_id, data["code"])):
                    reset_token = secrets.token_urlsafe(32)
                    challenge.reset_token_digest = _digest("token", challenge.challenge_id, reset_token)
                    challenge.code_digest = ""
                    challenge.verified_at = now
                    challenge.expires_at = now + timedelta(seconds=TOKEN_TTL_SECONDS)
                    challenge.save(update_fields=["reset_token_digest", "code_digest", "verified_at", "expires_at"])
                else:
                    challenge.attempts += 1
                    if challenge.attempts >= MAX_CODE_ATTEMPTS:
                        challenge.code_digest = ""
                    challenge.save(update_fields=["attempts", "code_digest"])
        # Return after atomic ends so failed guesses are committed, never rolled back.
        if reset_token is None:
            return Response({"detail": INVALID_CODE_DETAIL}, status=status.HTTP_400_BAD_REQUEST)
        return Response({"reset_token": reset_token, "expires_in": TOKEN_TTL_SECONDS})


@method_decorator(csrf_protect, name="dispatch")
class PasswordResetConfirmView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [PasswordResetConfirmThrottle]

    def post(self, request):
        serializer = ResetPasswordSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        now = timezone.now()
        with transaction.atomic():
            user = _locked_user(data["email"])
            challenge = _valid_challenge(user, data["challenge_id"], data["email"], now)
            if (
                challenge is None
                or challenge.verified_at is None
                or not challenge.reset_token_digest
                or not constant_time_compare(challenge.reset_token_digest, _digest("token", challenge.challenge_id, data["reset_token"]))
            ):
                return Response({"detail": INVALID_TOKEN_DETAIL}, status=status.HTTP_400_BAD_REQUEST)
            try:
                validate_password(data["password"], user)
            except DjangoValidationError as exc:
                raise ValidationError({"password": list(exc.messages)})
            previous_session_key = user.active_session_key
            user.set_password(data["password"])
            user.active_session_key = ""
            user.save(update_fields=["password", "active_session_key"])
            if previous_session_key:
                Session.objects.filter(session_key=previous_session_key).delete()
            challenge.consumed_at = now
            challenge.code_digest = ""
            challenge.reset_token_digest = ""
            challenge.save(update_fields=["consumed_at", "code_digest", "reset_token_digest"])
        # Password hashes invalidate all existing authenticated sessions in Django.
        logout(request)
        confirmation_email_sent = True
        try:
            send_password_reset_confirmation(user, challenge_id=challenge.challenge_id)
        except EmailDeliveryError:
            confirmation_email_sent = False
            logger.warning("La contraseña se actualizó, pero no se pudo enviar el correo de confirmación.")
        detail = (
            "Tu contraseña se ha actualizado. Te enviamos un correo de confirmación."
            if confirmation_email_sent else
            "Tu contraseña se ha actualizado. No pudimos enviar el correo de confirmación, pero ya puedes iniciar sesión."
        )
        return Response({"detail": detail, "confirmation_email_sent": confirmation_email_sent})
