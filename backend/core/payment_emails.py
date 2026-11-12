"""Card authorization emails and a durable, retried top-up receipt outbox."""
import logging
from datetime import timedelta
from html import escape

from django.db import transaction
from django.utils import timezone

from .emails import EmailDeliveryError, _send_email
from .models import PaymentEmailOutbox

logger = logging.getLogger(__name__)


def send_card_verification_code(user, card, code, *, challenge_id):
    name = user.nombre or user.username
    label = f"{card.brand.upper()} terminada en {card.last4}"
    text = (
        f"Hola, {name}.\n\nTu código para registrar la tarjeta de prueba {label} "
        f"en App Finanzas Mauricio es: {code}\n\n"
        "Vence en 10 minutos y solo se puede utilizar una vez. Ingresa el código "
        "en la aplicación para activar esta tarjeta. Este registro y los pagos son "
        "simulados; no se realiza ningún cargo real.\n\n"
        "Si no solicitaste este registro, no compartas el código."
    )
    html = (
        f"<h1>Confirma tu tarjeta de prueba</h1><p>Hola, {escape(name)}.</p>"
        f"<p>Tarjeta: {escape(label)}.</p>"
        f'<p style="font-size:32px;letter-spacing:8px;font-weight:bold">{escape(code)}</p>'
        "<p>Vence en 10 minutos y solo se puede utilizar una vez. Ingresa el código "
        "en App Finanzas Mauricio para activar esta tarjeta.</p>"
        "<p>Registro y pagos simulados. No se realiza ningún cargo real.</p>"
        "<p>Si no lo solicitaste, no compartas el código.</p>"
    )
    return _send_email(
        to=user.email, subject="Confirma tu tarjeta de prueba en App Finanzas Mauricio",
        text=text, html=html, idempotency_key=f"card-verification/{challenge_id}",
    )


def send_topup_confirmation(outbox):
    topup = outbox.topup
    card = topup.card
    date = timezone.localtime(topup.credited_at).strftime("%d/%m/%Y %H:%M")
    amount = f"${topup.amount:,.2f} MXN"
    label = f"{card.brand.upper()} terminada en {card.last4}"
    text = (
        f"Tu recarga simulada de {amount} se acreditó correctamente en App Finanzas Mauricio.\n\n"
        f"Tarjeta de prueba: {label}\nFecha: {date} (Ciudad de México)\nReferencia: {topup.pk}\n\n"
        "Ya puedes utilizar este saldo dentro de la aplicación. Esta operación es "
        "de prueba y no se realizó ningún cargo real."
    )
    html = (
        "<h1>Tu saldo simulado está disponible</h1>"
        f"<p>Se acreditaron <strong>{escape(amount)}</strong> en App Finanzas Mauricio.</p>"
        f"<p>Tarjeta de prueba: {escape(label)}<br>Fecha: {escape(date)} (Ciudad de México)"
        f"<br>Referencia: {escape(str(topup.pk))}</p>"
        "<p>Ya puedes utilizar este saldo dentro de la aplicación.</p>"
        "<p>Operación de prueba. No se realizó ningún cargo real.</p>"
    )
    return _send_email(
        to=outbox.recipient, subject="Tu recarga simulada se acreditó correctamente",
        text=text, html=html, idempotency_key=f"topup-confirmation/{topup.pk}",
    )


def deliver_pending_payment_emails(*, limit=25):
    """Claim rows under a lock; a delivery failure never rolls back a credit.

    The provider idempotency key also handles a worker dying after the provider
    accepts the receipt but before the database records its delivery.
    """
    now = timezone.now()
    ids = list(PaymentEmailOutbox.objects.filter(
        sent_at__isnull=True, next_attempt_at__lte=now,
    ).order_by("created_at").values_list("pk", flat=True)[:limit])
    result = {"sent": 0, "failed": 0}
    for outbox_id in ids:
        with transaction.atomic():
            outbox = PaymentEmailOutbox.objects.select_for_update().select_related("topup__card").filter(pk=outbox_id).first()
            now = timezone.now()
            if outbox is None or outbox.sent_at is not None or outbox.next_attempt_at > now:
                continue
            outbox.attempts += 1
            outbox.last_attempt_at = now
            try:
                send_topup_confirmation(outbox)
            except EmailDeliveryError:
                delay = min(3600, 30 * 2 ** min(outbox.attempts - 1, 7))
                outbox.next_attempt_at = now + timedelta(seconds=delay)
                outbox.save(update_fields=["attempts", "last_attempt_at", "next_attempt_at"])
                result["failed"] += 1
                logger.warning("No se pudo enviar un comprobante de recarga; se reintentará.")
            else:
                outbox.sent_at = timezone.now()
                outbox.save(update_fields=["attempts", "last_attempt_at", "sent_at"])
                result["sent"] += 1
    return result
