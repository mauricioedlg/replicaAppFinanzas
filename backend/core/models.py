from decimal import Decimal
import uuid

from django.contrib.auth.models import AbstractUser
from django.db import models
from django.db.models.functions import Lower
from django.utils import timezone


class User(AbstractUser):
    email = models.EmailField(unique=True)
    nombre = models.CharField(max_length=150)
    telefono = models.CharField(max_length=30, blank=True)
    cash_balance = models.DecimalField(max_digits=18, decimal_places=2, default=Decimal("0.00"))
    notifications = models.BooleanField(default=True)
    dark_mode = models.BooleanField(default=False)
    active_session_key = models.CharField(max_length=40, blank=True, default="", editable=False)

    class Meta:
        db_table = "usuarios"
        constraints = [
            models.UniqueConstraint(Lower("email"), name="usuarios_email_ci_unique"),
            models.UniqueConstraint(Lower("username"), name="usuarios_username_ci_unique"),
            models.CheckConstraint(condition=models.Q(cash_balance__gte=0), name="usuarios_cash_nonnegative"),
        ]

    def __str__(self):
        return self.nombre or self.username


class LoginChallenge(models.Model):
    """One pending email verification and durable send allowance per account."""

    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="login_challenge")
    challenge_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    email = models.EmailField()
    password_fingerprint = models.CharField(max_length=64)
    browser_digest = models.CharField(max_length=64)
    code_digest = models.CharField(max_length=64, blank=True)
    expires_at = models.DateTimeField()
    consumed_at = models.DateTimeField(null=True, blank=True)
    attempts = models.PositiveSmallIntegerField(default=0)
    sent_at = models.DateTimeField()
    send_window_started_at = models.DateTimeField()
    send_count = models.PositiveSmallIntegerField(default=0)

    class Meta:
        db_table = "login_challenges"


class PasswordResetChallenge(models.Model):
    """One durable recovery attempt and send budget per account; no raw secrets."""

    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="password_reset_challenge")
    challenge_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    email = models.EmailField()
    password_fingerprint = models.CharField(max_length=64)
    code_digest = models.CharField(max_length=64, blank=True)
    reset_token_digest = models.CharField(max_length=64, blank=True)
    expires_at = models.DateTimeField()
    verified_at = models.DateTimeField(null=True, blank=True)
    consumed_at = models.DateTimeField(null=True, blank=True)
    attempts = models.PositiveSmallIntegerField(default=0)
    sent_at = models.DateTimeField()
    send_window_started_at = models.DateTimeField()
    send_count = models.PositiveSmallIntegerField(default=0)

    class Meta:
        db_table = "password_reset_challenges"


class Stock(models.Model):
    symbol = models.CharField(max_length=12, unique=True)
    nombre = models.CharField(max_length=100)
    sector = models.CharField(max_length=80)
    precio = models.DecimalField(max_digits=18, decimal_places=2)
    cambio_porcentual = models.DecimalField(max_digits=7, decimal_places=2, default=0)
    color = models.CharField(max_length=7, default="#22c55e")
    fecha_actualizacion = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "acciones"
        ordering = ["nombre"]
        constraints = [models.CheckConstraint(condition=models.Q(precio__gt=0), name="acciones_positive_price")]

    def __str__(self):
        return self.symbol


class Holding(models.Model):
    usuario = models.ForeignKey(User, on_delete=models.CASCADE, related_name="holdings")
    accion = models.ForeignKey(Stock, on_delete=models.PROTECT, related_name="holdings")
    quantity = models.DecimalField(max_digits=18, decimal_places=6)
    invested = models.DecimalField(max_digits=18, decimal_places=2)

    class Meta:
        db_table = "portafolio"
        ordering = ["accion__nombre"]
        constraints = [
            models.UniqueConstraint(fields=["usuario", "accion"], name="portafolio_user_stock_unique"),
            models.CheckConstraint(condition=models.Q(quantity__gt=0), name="portafolio_positive_quantity"),
            models.CheckConstraint(condition=models.Q(invested__gte=0), name="portafolio_nonnegative_invested"),
        ]


class Transaction(models.Model):
    class Type(models.TextChoices):
        BUY = "buy", "Compra"
        SELL = "sell", "Venta"
        DEPOSIT = "deposit", "Depósito"

    usuario = models.ForeignKey(User, on_delete=models.CASCADE, related_name="transactions")
    accion = models.ForeignKey(Stock, null=True, blank=True, on_delete=models.PROTECT, related_name="transactions")
    tipo = models.CharField(max_length=7, choices=Type.choices)
    descripcion = models.CharField(max_length=255)
    cantidad = models.DecimalField(max_digits=18, decimal_places=6, default=0)
    precio_unitario = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    monto = models.DecimalField(max_digits=18, decimal_places=2)
    fecha = models.DateTimeField()

    class Meta:
        db_table = "transacciones"
        ordering = ["-fecha", "-id"]
        indexes = [models.Index(fields=["usuario", "-fecha"], name="trans_user_date_idx")]
        constraints = [
            models.CheckConstraint(condition=models.Q(monto__gt=0), name="transacciones_positive_amount"),
            models.CheckConstraint(condition=models.Q(tipo__in=["buy", "sell", "deposit"]), name="transacciones_valid_type"),
            models.CheckConstraint(condition=(models.Q(tipo="deposit", accion__isnull=True, cantidad=0, precio_unitario=0) | models.Q(tipo__in=["buy", "sell"], accion__isnull=False, cantidad__gt=0, precio_unitario__gt=0)), name="transacciones_valid_shape"),
        ]


class StripeCustomer(models.Model):
    """Durable local identity, including before a retried Stripe request succeeds."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    usuario = models.OneToOneField(User, on_delete=models.CASCADE, related_name="stripe_customer")
    customer_id = models.CharField(max_length=255, unique=True, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "stripe_customers"


class PaymentCard(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    usuario = models.ForeignKey(User, on_delete=models.CASCADE, related_name="payment_cards")
    request_id = models.UUIDField(default=uuid.uuid4)
    stripe_customer_id = models.CharField(max_length=255, blank=True)
    stripe_setup_intent_id = models.CharField(max_length=255, unique=True, null=True, blank=True)
    stripe_payment_method_id = models.CharField(max_length=255, unique=True, null=True, blank=True)
    brand = models.CharField(max_length=30, blank=True)
    last4 = models.CharField(max_length=4, blank=True)
    exp_month = models.PositiveSmallIntegerField(null=True, blank=True)
    exp_year = models.PositiveSmallIntegerField(null=True, blank=True)
    verified_at = models.DateTimeField(null=True, blank=True)
    verified_email = models.EmailField(blank=True)
    disabled_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "payment_cards"
        ordering = ["-created_at"]
        constraints = [models.UniqueConstraint(fields=["usuario", "request_id"], name="card_user_request_unique")]

    @property
    def is_expired(self):
        today = timezone.localdate()
        return bool(self.exp_year and self.exp_month and (self.exp_year, self.exp_month) < (today.year, today.month))

    @property
    def is_active(self):
        return bool(
            self.verified_at and self.stripe_payment_method_id and not self.disabled_at
            and not self.is_expired and self.verified_email.casefold() == self.usuario.email.casefold()
        )


class CardVerification(models.Model):
    card = models.OneToOneField(PaymentCard, on_delete=models.CASCADE, related_name="verification")
    challenge_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    email = models.EmailField()
    code_digest = models.CharField(max_length=64, blank=True)
    expires_at = models.DateTimeField()
    consumed_at = models.DateTimeField(null=True, blank=True)
    attempts = models.PositiveSmallIntegerField(default=0)
    sent_at = models.DateTimeField()
    send_window_started_at = models.DateTimeField()
    send_count = models.PositiveSmallIntegerField(default=0)

    class Meta:
        db_table = "card_verifications"


class TopUp(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending", "Pendiente"
        SUCCEEDED = "succeeded", "Acreditada"
        FAILED = "failed", "No completada"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    usuario = models.ForeignKey(User, on_delete=models.PROTECT, related_name="topups")
    card = models.ForeignKey(PaymentCard, on_delete=models.PROTECT, related_name="topups")
    request_id = models.UUIDField(default=uuid.uuid4)
    amount = models.DecimalField(max_digits=18, decimal_places=2)
    currency = models.CharField(max_length=3, default="mxn")
    stripe_customer_id = models.CharField(max_length=255, blank=True)
    stripe_payment_intent_id = models.CharField(max_length=255, unique=True, null=True, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING)
    credited_at = models.DateTimeField(null=True, blank=True)
    transaction = models.OneToOneField(Transaction, on_delete=models.PROTECT, null=True, blank=True, related_name="topup")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "payment_topups"
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(fields=["usuario", "request_id"], name="topup_user_request_unique"),
            models.CheckConstraint(condition=models.Q(amount__gt=0), name="topup_positive_amount"),
            models.CheckConstraint(condition=models.Q(currency="mxn"), name="topup_currency_mxn"),
            models.CheckConstraint(condition=models.Q(status__in=["pending", "succeeded", "failed"]), name="topup_valid_status"),
            models.CheckConstraint(
                condition=(models.Q(status="succeeded", credited_at__isnull=False, transaction__isnull=False)
                           | models.Q(status__in=["pending", "failed"], credited_at__isnull=True, transaction__isnull=True)),
                name="topup_credit_consistent",
            ),
        ]


class PaymentEmailOutbox(models.Model):
    topup = models.OneToOneField(TopUp, on_delete=models.CASCADE, related_name="confirmation_email")
    recipient = models.EmailField()
    sent_at = models.DateTimeField(null=True, blank=True)
    attempts = models.PositiveIntegerField(default=0)
    last_attempt_at = models.DateTimeField(null=True, blank=True)
    next_attempt_at = models.DateTimeField(default=timezone.now)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "payment_email_outbox"
        ordering = ["created_at"]
