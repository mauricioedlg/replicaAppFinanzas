"""Test-only Stripe integration. Only a signed webhook may credit a top-up."""
import logging
import math
import secrets
import uuid
from datetime import timedelta
from decimal import Decimal, InvalidOperation

import stripe
from django.conf import settings
from django.db import transaction
from django.db.models import Sum
from django.utils import timezone
from django.utils.crypto import constant_time_compare, salted_hmac
from rest_framework.exceptions import APIException, NotFound, ValidationError

from .emails import ensure_email_configured
from .models import CardVerification, PaymentCard, PaymentEmailOutbox, StripeCustomer, TopUp, User
from .payment_emails import send_card_verification_code
from .services import MAX_MONEY, deposit_funds, money

logger = logging.getLogger(__name__)
INVALID_CODE_DETAIL = "El código es inválido o ha vencido. Solicita uno nuevo e inténtalo de nuevo."
CODE_TTL_SECONDS = 600
MAX_CODE_ATTEMPTS = 5
RESEND_COOLDOWN_SECONDS = 60
MAX_SENDS_PER_HOUR = 5


class PaymentsUnavailable(APIException):
    status_code = 503
    default_detail = "Los pagos de prueba todavía no están disponibles. Inténtalo más tarde."


class CardVerificationRateLimit(APIException):
    status_code = 429

    def __init__(self, retry_after):
        self.retry_after = max(1, math.ceil(retry_after))
        super().__init__({"detail": "Espera antes de solicitar otro código de tarjeta.", "retry_after": self.retry_after})


def payment_limits():
    try:
        minimum = Decimal(str(getattr(settings, "STRIPE_MIN_TOPUP", "10.00")))
        maximum = Decimal(str(getattr(settings, "STRIPE_MAX_TOPUP", "999999.99")))
        if not minimum.is_finite() or not maximum.is_finite() or minimum < Decimal("10.00") or maximum > Decimal("999999.99") or minimum > maximum:
            raise ValueError
        if minimum != money(minimum) or maximum != money(maximum):
            raise ValueError
        return minimum, maximum
    except (InvalidOperation, ValueError, TypeError):
        raise PaymentsUnavailable() from None


def payment_config():
    secret = str(getattr(settings, "STRIPE_SECRET_KEY", "")).strip()
    public = str(getattr(settings, "STRIPE_PUBLISHABLE_KEY", "")).strip()
    webhook = str(getattr(settings, "STRIPE_WEBHOOK_SECRET", "")).strip()
    try:
        minimum, maximum = payment_limits()
        limits_valid = True
    except PaymentsUnavailable:
        minimum, maximum, limits_valid = Decimal("10.00"), Decimal("999999.99"), False
    ready = bool(
        secret.startswith(("sk_test_", "rk_test_")) and len(secret) > 8
        and public.startswith("pk_test_") and len(public) > 8
        and webhook.startswith("whsec_") and len(webhook) > 6 and limits_valid
    )
    return {
        "configured": ready, "publishable_key": public if public.startswith("pk_test_") else "",
        "mode": "test", "min_amount": str(money(minimum)), "max_amount": str(money(maximum)),
        "detail": "Pagos de prueba disponibles." if ready else "Los pagos de prueba todavía no están habilitados.",
    }


def ensure_payments_configured():
    if not payment_config()["configured"]:
        raise PaymentsUnavailable()


def get_stripe_client():
    ensure_payments_configured()
    try:
        timeout = float(getattr(settings, "STRIPE_TIMEOUT_SECONDS", 10))
        if not 0 < timeout <= 60:
            raise ValueError
    except (ValueError, TypeError):
        raise PaymentsUnavailable() from None
    return stripe.StripeClient(
        settings.STRIPE_SECRET_KEY,
        http_client=stripe.RequestsClient(timeout=timeout), max_network_retries=1,
    )


def stripe_call(callback):
    try:
        result = callback()
        # SDK 17 resources deliberately no longer expose dict.get(). Normalize
        # once at the provider boundary, including all nested Stripe objects.
        return result.to_dict() if isinstance(result, stripe.StripeObject) else result
    except stripe.StripeError as exc:
        # Stripe messages may contain credentials, addresses or client secrets.
        logger.warning("No se pudo completar una solicitud Stripe (%s).", type(exc).__name__)
        raise PaymentsUnavailable("No pudimos contactar al servicio de pagos. Puedes reintentar la misma operación.") from None


def object_id(value):
    return value.get("id") if hasattr(value, "get") else value


def require_test_object(value):
    if value.get("livemode") is not False:
        raise ValidationError({"detail": "Solo se permiten operaciones en el entorno de pruebas."})


def card_data(card):
    if card.disabled_at:
        state = "disabled"
    elif card.is_expired:
        state = "expired"
    else:
        state = "active" if card.is_active else "pending"
    return {
        "id": str(card.pk), "brand": card.brand, "last4": card.last4,
        "exp_month": card.exp_month, "exp_year": card.exp_year, "status": state,
        "verified_at": card.verified_at.isoformat() if card.verified_at else None,
    }


def topup_data(topup):
    return {
        "id": str(topup.pk), "status": topup.status, "amount": str(money(topup.amount)),
        "currency": topup.currency, "card": card_data(topup.card),
        "created_at": topup.created_at.isoformat(),
        "credited_at": topup.credited_at.isoformat() if topup.credited_at else None,
    }


def owned_card(user, card_id, *, lock=False):
    rows = PaymentCard.objects.select_related("usuario")
    if lock:
        rows = rows.select_for_update(of=("self",))
    card = rows.filter(pk=card_id, usuario=user).first()
    if card is None:
        raise NotFound("La tarjeta no está disponible.")
    if card.disabled_at:
        raise ValidationError({"detail": "Esta tarjeta se eliminó. Registra una tarjeta nueva."})
    return card


def stripe_customer_for(user, client):
    # Save the local id before calling Stripe. A network timeout must not discard
    # the idempotency key that is needed to recover the remote result safely.
    with transaction.atomic():
        account = User.objects.select_for_update().get(pk=user.pk)
        customer, _ = StripeCustomer.objects.get_or_create(usuario=account)
    if not customer.customer_id:
        remote = stripe_call(lambda: client.v1.customers.create(
            {"metadata": {"app_customer_id": str(customer.pk)}},
            options={"idempotency_key": f"customer:{customer.pk}"},
        ))
        require_test_object(remote)
        with transaction.atomic():
            User.objects.select_for_update().get(pk=user.pk)
            customer = StripeCustomer.objects.select_for_update().get(pk=customer.pk)
            if customer.customer_id and customer.customer_id != remote["id"]:
                raise ValidationError({"detail": "No pudimos vincular el cliente de pruebas."})
            customer.customer_id = remote["id"]
            customer.save(update_fields=["customer_id"])
    return customer


def create_card_setup(user, request_id):
    ensure_payments_configured()
    client = get_stripe_client()
    customer = stripe_customer_for(user, client)
    with transaction.atomic():
        account = User.objects.select_for_update().get(pk=user.pk)
        card, _ = PaymentCard.objects.get_or_create(
            usuario=account, request_id=request_id, defaults={"stripe_customer_id": customer.customer_id},
        )
        if card.disabled_at:
            raise ValidationError({"detail": "Este registro se eliminó. Inicia un registro nuevo."})
    if card.stripe_setup_intent_id:
        setup = stripe_call(lambda: client.v1.setup_intents.retrieve(card.stripe_setup_intent_id))
    else:
        setup = stripe_call(lambda: client.v1.setup_intents.create(
            {
                "customer": customer.customer_id, "allowed_payment_method_types": ["card"],
                "usage": "on_session", "metadata": {"card_registration_id": str(card.pk)},
            }, options={"idempotency_key": f"card-setup:{card.pk}"},
        ))
    require_test_object(setup)
    if object_id(setup.get("customer")) != customer.customer_id:
        raise ValidationError({"detail": "El registro de tarjeta no corresponde a tu cuenta."})
    with transaction.atomic():
        User.objects.select_for_update().get(pk=user.pk)
        card = owned_card(user, card.pk, lock=True)
        card.stripe_customer_id = customer.customer_id
        card.stripe_setup_intent_id = setup["id"]
        card.save(update_fields=["stripe_customer_id", "stripe_setup_intent_id"])
    return {"card": card_data(card), "client_secret": setup["client_secret"]}


def verification_digest(challenge_id, code):
    return salted_hmac("folio.card-verification.code", f"{challenge_id}:{code}", algorithm="sha256").hexdigest()


def request_card_verification(user, card_id):
    ensure_payments_configured()
    ensure_email_configured()
    card = owned_card(user, card_id)
    if not card.stripe_setup_intent_id:
        raise ValidationError({"detail": "Completa primero el formulario de tarjeta."})
    client = get_stripe_client()
    setup = stripe_call(lambda: client.v1.setup_intents.retrieve(card.stripe_setup_intent_id))
    require_test_object(setup)
    customer_id = StripeCustomer.objects.filter(usuario=user).values_list("customer_id", flat=True).first()
    if setup.get("status") != "succeeded" or object_id(setup.get("customer")) != customer_id or card.stripe_customer_id != customer_id:
        raise ValidationError({"detail": "No se ha completado el registro de esta tarjeta en Stripe."})
    method_id = object_id(setup.get("payment_method"))
    if not method_id:
        raise ValidationError({"detail": "No se recibió una tarjeta válida."})
    method = stripe_call(lambda: client.v1.payment_methods.retrieve(method_id))
    require_test_object(method)
    details = method.get("card") or {}
    if method.get("type") != "card" or object_id(method.get("customer")) != customer_id or not details.get("last4"):
        raise ValidationError({"detail": "La tarjeta no corresponde a tu cuenta."})
    now = timezone.now()
    with transaction.atomic():
        account = User.objects.select_for_update().get(pk=user.pk)
        card = owned_card(account, card_id, lock=True)
        if card.is_active:
            raise ValidationError({"detail": "Esta tarjeta ya está verificada."})
        duplicate = PaymentCard.objects.filter(stripe_payment_method_id=method_id).exclude(pk=card.pk).exists()
        if duplicate:
            raise ValidationError({"detail": "Este método de pago ya está registrado."})
        card.stripe_payment_method_id = method_id
        card.brand = str(details.get("brand", "card"))[:30]
        card.last4 = str(details["last4"])[-4:]
        card.exp_month = details.get("exp_month")
        card.exp_year = details.get("exp_year")
        if card.is_expired:
            raise ValidationError({"detail": "La tarjeta ha vencido. Registra una tarjeta vigente."})
        challenge = CardVerification.objects.select_for_update().filter(card=card).first()
        window = now - timedelta(hours=1)
        recent = CardVerification.objects.filter(card__usuario=account, send_window_started_at__gt=window)
        sent_count = recent.aggregate(total=Sum("send_count"))["total"] or 0
        if sent_count >= MAX_SENDS_PER_HOUR:
            first = recent.order_by("send_window_started_at").first()
            raise CardVerificationRateLimit((first.send_window_started_at + timedelta(hours=1) - now).total_seconds())
        if challenge and challenge.sent_at > now - timedelta(seconds=RESEND_COOLDOWN_SECONDS):
            raise CardVerificationRateLimit((challenge.sent_at + timedelta(seconds=RESEND_COOLDOWN_SECONDS) - now).total_seconds())
        if challenge is None:
            challenge = CardVerification(card=card, send_window_started_at=now, sent_at=now, expires_at=now)
        if challenge.send_window_started_at <= window:
            challenge.send_window_started_at = now
            challenge.send_count = 0
        challenge.challenge_id = uuid.uuid4()
        challenge.email = account.email
        code = f"{secrets.randbelow(1_000_000):06d}"
        challenge.code_digest = verification_digest(challenge.challenge_id, code)
        challenge.expires_at = now + timedelta(seconds=CODE_TTL_SECONDS)
        challenge.consumed_at = None
        challenge.attempts = 0
        challenge.sent_at = now
        challenge.send_count += 1
        card.save(update_fields=["stripe_payment_method_id", "brand", "last4", "exp_month", "exp_year"])
        challenge.save()
        send_card_verification_code(account, card, code, challenge_id=challenge.challenge_id)
        local, domain = account.email.rsplit("@", 1)
        return {
            "card": card_data(card), "challenge_id": str(challenge.challenge_id),
            "email_hint": local[:2] + "***@" + domain, "expires_in": CODE_TTL_SECONDS,
            "retry_after": RESEND_COOLDOWN_SECONDS, "detail": "Te enviamos un código para confirmar esta tarjeta.",
        }


def confirm_card_verification(user, card_id, challenge_id, code):
    ensure_payments_configured()
    now = timezone.now()
    verified = None
    with transaction.atomic():
        account = User.objects.select_for_update().get(pk=user.pk)
        card = owned_card(account, card_id, lock=True)
        challenge = CardVerification.objects.select_for_update().filter(card=card, challenge_id=challenge_id).first()
        if (challenge is not None and challenge.consumed_at is None and challenge.code_digest
                and challenge.expires_at > now and challenge.attempts < MAX_CODE_ATTEMPTS
                and challenge.email.casefold() == account.email.casefold()
                and card.stripe_payment_method_id and not card.is_expired):
            if constant_time_compare(challenge.code_digest, verification_digest(challenge.challenge_id, code)):
                challenge.consumed_at = now
                challenge.code_digest = ""
                challenge.save(update_fields=["consumed_at", "code_digest"])
                card.verified_at = now
                card.verified_email = account.email
                card.save(update_fields=["verified_at", "verified_email"])
                verified = card
            else:
                challenge.attempts += 1
                if challenge.attempts >= MAX_CODE_ATTEMPTS:
                    challenge.code_digest = ""
                challenge.save(update_fields=["attempts", "code_digest"])
    # Raising outside atomic preserves the invalid-attempt budget.
    if verified is None:
        raise ValidationError({"detail": INVALID_CODE_DETAIL})
    return {"card": card_data(verified), "detail": "Tarjeta de prueba verificada correctamente."}


def disable_card(user, card_id):
    with transaction.atomic():
        account = User.objects.select_for_update().get(pk=user.pk)
        card = PaymentCard.objects.select_for_update().filter(usuario=account, pk=card_id).first()
        if card is None:
            raise NotFound("La tarjeta no está disponible.")
        card.disabled_at = timezone.now()
        card.save(update_fields=["disabled_at"])
        CardVerification.objects.filter(card=card).update(code_digest="", consumed_at=timezone.now())


def create_topup(user, card_id, amount, request_id):
    ensure_payments_configured()
    minimum, maximum = payment_limits()
    if not amount.is_finite() or amount != money(amount) or not minimum <= amount <= maximum:
        raise ValidationError({"amount": [f"El monto debe estar entre ${minimum:,.2f} y ${maximum:,.2f} MXN."]})
    with transaction.atomic():
        account = User.objects.select_for_update().get(pk=user.pk)
        existing = TopUp.objects.select_related("card__usuario").filter(usuario=account, request_id=request_id).first()
        if existing:
            if existing.card_id != card_id or existing.amount != amount:
                raise ValidationError({"detail": "Esta referencia ya corresponde a otra recarga. Inicia una operación nueva."})
            topup = existing
        else:
            card = owned_card(account, card_id, lock=True)
            if not card.is_active:
                raise ValidationError({"detail": "Confirma primero el código de esta tarjeta para agregar fondos."})
            customer_id = StripeCustomer.objects.filter(usuario=account).values_list("customer_id", flat=True).first()
            if not customer_id or customer_id != card.stripe_customer_id:
                raise ValidationError({"detail": "La tarjeta no corresponde al cliente de tu cuenta."})
            if account.cash_balance + amount > MAX_MONEY:
                raise ValidationError({"amount": ["La recarga supera el límite de saldo permitido."]})
            topup = TopUp.objects.create(
                usuario=account, card=card, request_id=request_id, amount=amount,
                stripe_customer_id=customer_id,
            )
    client = get_stripe_client()
    if topup.stripe_payment_intent_id:
        payment = stripe_call(lambda: client.v1.payment_intents.retrieve(topup.stripe_payment_intent_id))
    else:
        payment = stripe_call(lambda: client.v1.payment_intents.create(
            {
                "amount": int(amount * 100), "currency": "mxn", "customer": topup.stripe_customer_id,
                "payment_method": topup.card.stripe_payment_method_id, "allowed_payment_method_types": ["card"],
                "metadata": {"topup_id": str(topup.pk)}, "description": "Recarga de saldo simulado App Finanzas Mauricio",
            }, options={"idempotency_key": f"topup:{topup.pk}"},
        ))
    require_test_object(payment)
    if (object_id(payment.get("customer")) != topup.stripe_customer_id
            or payment.get("amount") != int(topup.amount * 100) or payment.get("currency") != "mxn"
            or object_id(payment.get("payment_method")) != topup.card.stripe_payment_method_id):
        raise ValidationError({"detail": "La confirmación del pago no corresponde a esta recarga."})
    with transaction.atomic():
        User.objects.select_for_update().get(pk=user.pk)
        topup = TopUp.objects.select_for_update().select_related("card__usuario").get(pk=topup.pk)
        if topup.stripe_payment_intent_id and topup.stripe_payment_intent_id != payment["id"]:
            raise ValidationError({"detail": "Esta recarga ya tiene un pago asociado."})
        topup.stripe_payment_intent_id = payment["id"]
        topup.save(update_fields=["stripe_payment_intent_id"])
    # Browser success still must wait for the signed webhook before crediting.
    return {"topup": topup_data(topup), "client_secret": payment.get("client_secret", "")}


def process_payment_event(event):
    """Validate the signed snapshot and apply a payment transition atomically."""
    if isinstance(event, stripe.StripeObject):
        event = event.to_dict()
    if event.get("livemode") is not False:
        raise ValidationError({"detail": "Solo se permiten eventos de prueba."})
    event_type = event.get("type")
    if event_type not in {"payment_intent.succeeded", "payment_intent.payment_failed"}:
        return
    payment = (event.get("data") or {}).get("object") or {}
    require_test_object(payment)
    payment_id = payment.get("id")
    metadata_id = (payment.get("metadata") or {}).get("topup_id")
    if not metadata_id:
        # Other products in the same Stripe test account are outside this app.
        return
    try:
        topup_id = uuid.UUID(str(metadata_id))
    except (TypeError, ValueError):
        raise ValidationError({"detail": "Referencia de recarga inválida."}) from None
    original = TopUp.objects.filter(pk=topup_id).values("usuario_id").first()
    if original is None:
        return
    with transaction.atomic():
        account = User.objects.select_for_update().get(pk=original["usuario_id"])
        topup = TopUp.objects.select_for_update().select_related("card__usuario").get(pk=topup_id)
        customer_id = topup.stripe_customer_id or StripeCustomer.objects.filter(usuario=account).values_list("customer_id", flat=True).first()
        if (not payment_id or not topup.stripe_payment_intent_id or payment_id != topup.stripe_payment_intent_id
                or object_id(payment.get("customer")) != customer_id or not customer_id
                or payment.get("currency") != topup.currency or payment.get("amount") != int(topup.amount * 100)
                or object_id(payment.get("payment_method")) != topup.card.stripe_payment_method_id):
            raise ValidationError({"detail": "El evento no corresponde a la recarga registrada."})
        if topup.credited_at is not None:
            return
        if event_type == "payment_intent.payment_failed":
            topup.status = TopUp.Status.FAILED
            topup.save(update_fields=["status"])
            return
        if payment.get("status") != "succeeded" or payment.get("amount_received") != int(topup.amount * 100):
            raise ValidationError({"detail": "El pago todavía no está confirmado por el importe esperado."})
        _, record = deposit_funds(account, topup.amount)
        record.descripcion = f"Recarga simulada con {topup.card.brand.upper()} terminada en {topup.card.last4}"
        record.save(update_fields=["descripcion"])
        topup.status = TopUp.Status.SUCCEEDED
        topup.credited_at = timezone.now()
        topup.transaction = record
        topup.save(update_fields=["status", "credited_at", "transaction"])
        PaymentEmailOutbox.objects.get_or_create(topup=topup, defaults={"recipient": account.email})
