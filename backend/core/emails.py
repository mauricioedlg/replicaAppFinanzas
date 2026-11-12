"""Transactional security emails sent only by the Django server through Resend."""

import json
import logging
from email.utils import parseaddr
from html import escape
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import validate_email

logger = logging.getLogger(__name__)


class EmailDeliveryError(Exception):
    """The provider did not accept a transactional email."""


class EmailConfigurationError(EmailDeliveryError):
    """Security email delivery has not been configured yet."""


def ensure_email_configured():
    """Check before account lookup so missing setup never reveals an account."""
    if not settings.RESEND_API_KEY.strip() or not settings.RESEND_FROM_EMAIL.strip():
        raise EmailConfigurationError("Resend no está configurado.")
    for value in (settings.RESEND_FROM_EMAIL, settings.RESEND_REPLY_TO_EMAIL):
        if not value:
            continue
        if any(character in value for character in "\r\n"):
            raise EmailConfigurationError("Remitente de Resend inválido.")
        try:
            validate_email(parseaddr(value)[1])
        except ValidationError as exc:
            raise EmailConfigurationError("Remitente de Resend inválido.") from exc
    try:
        timeout = float(settings.RESEND_TIMEOUT_SECONDS)
    except (TypeError, ValueError) as exc:
        raise EmailConfigurationError("Tiempo de espera de Resend inválido.") from exc
    if not 0 < timeout <= 60:
        raise EmailConfigurationError("Tiempo de espera de Resend inválido.")
    return timeout


def _send_email(*, to, subject, text, html, idempotency_key):
    timeout = ensure_email_configured()
    payload = {
        "from": settings.RESEND_FROM_EMAIL,
        "to": [to],
        "subject": subject,
        "text": text,
        "html": html,
    }
    if settings.RESEND_REPLY_TO_EMAIL:
        payload["reply_to"] = settings.RESEND_REPLY_TO_EMAIL
    request = Request(
        "https://api.resend.com/emails",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {settings.RESEND_API_KEY}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "AppFinanzasMauricio/1.0",
            "Idempotency-Key": idempotency_key,
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            result = json.loads(response.read(65536).decode("utf-8"))
            if not 200 <= response.status < 300 or not isinstance(result, dict) or not result.get("id"):
                raise EmailDeliveryError("Respuesta inválida del proveedor de correo.")
            return result["id"]
    except HTTPError as exc:
        # Provider response bodies can contain addresses or secrets; never log them.
        logger.warning("Resend rechazó un correo de seguridad (HTTP %s).", exc.code)
        raise EmailDeliveryError("No se pudo enviar el correo de seguridad.") from None
    except (URLError, OSError, HTTPException, ValueError, UnicodeError) as exc:
        logger.warning("No se pudo contactar a Resend (%s).", type(exc).__name__)
        raise EmailDeliveryError("No se pudo enviar el correo de seguridad.") from None


def send_login_verification_code(user, code, *, challenge_id):
    name = user.nombre or user.username
    text = (
        f"Hola, {name}.\n\nTu código para iniciar sesión en App Finanzas Mauricio es: {code}\n\n"
        "El código vence en 10 minutos y solo puede utilizarse una vez. "
        "Ingresa este código en la pantalla de acceso para verificar tu cuenta.\n\n"
        "Después de verificarlo, tu sesión quedará guardada en este dispositivo. "
        "Si inicias sesión en otro dispositivo, la sesión anterior se cerrará.\n\n"
        "Si no solicitaste este acceso, no compartas el código y cambia tu contraseña."
    )
    html = (
        f"<h1>Verifica tu acceso a App Finanzas Mauricio</h1><p>Hola, {escape(name)}.</p>"
        "<p>Tu código para iniciar sesión es:</p>"
        f'<p style="font-size:32px;letter-spacing:8px;font-weight:bold">{escape(code)}</p>'
        "<p>Vence en 10 minutos y solo puede utilizarse una vez. Ingresa el código "
        "en la pantalla de acceso para verificar tu cuenta.</p>"
        "<p>Tu sesión quedará guardada en este dispositivo. Al iniciar sesión "
        "en otro dispositivo se cerrará la sesión anterior.</p>"
        "<p>Si no solicitaste este acceso, no compartas el código y cambia tu contraseña.</p>"
    )
    return _send_email(to=user.email, subject="Tu código para iniciar sesión en App Finanzas Mauricio", text=text, html=html,
                       idempotency_key=f"login-verification-code/{challenge_id}")


def send_password_reset_code(user, code, *, challenge_id):
    name = user.nombre or user.username
    text = (
        f"Hola, {name}.\n\nTu código para recuperar tu cuenta de App Finanzas Mauricio es: {code}\n\n"
        "El código vence en 10 minutos y solo puede utilizarse una vez. "
        "Ingresa este código en la pantalla de recuperación para crear una nueva contraseña.\n\n"
        "Si no solicitaste este cambio, ignora este correo y no compartas el código con nadie."
    )
    html = (
        f"<h1>Recupera tu cuenta de App Finanzas Mauricio</h1><p>Hola, {escape(name)}.</p>"
        "<p>Tu código de verificación es:</p>"
        f'<p style="font-size:32px;letter-spacing:8px;font-weight:bold">{escape(code)}</p>'
        "<p>Vence en 10 minutos y solo puede utilizarse una vez. Ingresa el código en la "
        "pantalla de recuperación para crear una nueva contraseña.</p>"
        "<p>Si no solicitaste este cambio, ignora este correo. No compartas el código con nadie.</p>"
    )
    return _send_email(to=user.email, subject="Tu código para recuperar tu cuenta de App Finanzas Mauricio", text=text, html=html,
                       idempotency_key=f"password-reset-code/{challenge_id}")


def send_password_reset_confirmation(user, *, challenge_id):
    name = user.nombre or user.username
    text = (
        f"Hola, {name}.\n\nTu contraseña de App Finanzas Mauricio se actualizó correctamente. "
        "Ya puedes iniciar sesión con tu nueva contraseña. Las sesiones anteriores se cerraron.\n\n"
        "Si no reconoces este cambio, recupera tu cuenta nuevamente y contacta a soporte. "
        "Nunca te pediremos tu contraseña por correo."
    )
    html = (
        f"<h1>Tu contraseña se actualizó</h1><p>Hola, {escape(name)}.</p>"
        "<p>Tu contraseña de App Finanzas Mauricio se actualizó correctamente. Ya puedes iniciar sesión "
        "con tu nueva contraseña. Las sesiones anteriores se cerraron.</p>"
        "<p>Si no reconoces este cambio, recupera tu cuenta nuevamente y contacta a soporte. "
        "Nunca te pediremos tu contraseña por correo.</p>"
    )
    return _send_email(to=user.email, subject="Tu contraseña de App Finanzas Mauricio se actualizó", text=text, html=html,
                       idempotency_key=f"password-reset-confirmation/{challenge_id}")
