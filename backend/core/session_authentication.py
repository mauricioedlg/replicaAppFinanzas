"""App sessions are trusted only after email verification on the active device."""

from django.conf import settings
from django.contrib.auth import get_user_model, login, logout
from django.contrib.sessions.models import Session
from django.db import transaction
from django.utils.crypto import constant_time_compare
from rest_framework.authentication import SessionAuthentication
from rest_framework.exceptions import AuthenticationFailed


class SingleDeviceSessionAuthentication(SessionAuthentication):
    def authenticate(self, request):
        # The base authenticator enforces CSRF before a session can be changed.
        result = super().authenticate(request)
        if result is None:
            return None
        user, _ = result
        current_key = request.session.session_key or ""
        if not user.active_session_key or not constant_time_compare(user.active_session_key, current_key):
            logout(request._request)
            raise AuthenticationFailed("Tu sesión terminó. Inicia sesión y verifica tu correo de nuevo.")
        return result


def establish_verified_session(request, user):
    """Call while holding the account row lock; the new verified device wins."""
    raw_request = getattr(request, "_request", request)
    previous_key = user.active_session_key
    login(raw_request, user, backend="core.authentication.IdentifierBackend")
    # Also rotate when logging in again to the same account's existing session.
    raw_request.session.cycle_key()
    raw_request.session.pop("login_verification_nonce", None)
    raw_request.session.set_expiry(settings.SESSION_COOKIE_AGE)
    raw_request.session.save()
    user.active_session_key = raw_request.session.session_key
    user.save(update_fields=["active_session_key"])
    if previous_key and previous_key != user.active_session_key:
        Session.objects.filter(session_key=previous_key).delete()
    request.user = user


def revoke_verified_session(request):
    """An old browser cannot revoke the newer browser's verified session."""
    key = request.session.session_key
    if request.user.is_authenticated and key:
        with transaction.atomic():
            get_user_model().objects.filter(pk=request.user.pk, active_session_key=key).update(active_session_key="")
            Session.objects.filter(session_key=key).delete()
    logout(getattr(request, "_request", request))
