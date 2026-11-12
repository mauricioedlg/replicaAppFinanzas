"""Payment lifecycle tests: all Stripe and email network calls are simulated."""
import hashlib
import hmac
import json
import time
from datetime import timedelta
from decimal import Decimal
from io import StringIO
from unittest.mock import Mock, patch
from uuid import uuid4

import stripe
from django.conf import settings
from django.core.cache import cache
from django.core.management import call_command
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from .emails import EmailDeliveryError
from .models import CardVerification, PaymentCard, PaymentEmailOutbox, StripeCustomer, TopUp, Transaction, User


def resource(**values):
    # Actual SDK response objects deliberately catch dict-method assumptions.
    return stripe.StripeObject.construct_from(values, None)


@override_settings(
    PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],
    STRIPE_SECRET_KEY="sk_test_payments_tests_only",
    STRIPE_PUBLISHABLE_KEY="pk_test_payments_tests_only",
    STRIPE_WEBHOOK_SECRET="whsec_payments_tests_only",
    STRIPE_MIN_TOPUP="10.00",
    STRIPE_MAX_TOPUP="999999.99",
    STRIPE_TIMEOUT_SECONDS=10,
    RESEND_API_KEY="re_payments_tests_only",
    RESEND_FROM_EMAIL="App Finanzas <security@example.com>",
    RESEND_REPLY_TO_EMAIL="",
)
class PaymentLifecycleTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="payment-owner", email="owner@example.com", nombre="Persona", password="ExamplePassword492!", cash_balance="1000.00")
        self.other = User.objects.create_user(username="payment-other", email="other@example.com", nombre="Otra persona", password="ExamplePassword492!", cash_balance="55.00")
        StripeCustomer.objects.create(usuario=self.user, customer_id="cus_owner")
        StripeCustomer.objects.create(usuario=self.other, customer_id="cus_other")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.stripe_client = Mock()
        self.client_factory = patch("core.payments.get_stripe_client", return_value=self.stripe_client).start()
        self.code_sender = patch("core.payments.send_card_verification_code").start()
        self.email_sender = patch("core.payment_emails._send_email", return_value="email_test_id").start()
        self.addCleanup(patch.stopall)
        self.card = self.make_card()
        self.stripe_client.v1.customers.create.return_value = resource(id="cus_owner", livemode=False)
        self.stripe_client.v1.setup_intents.create.return_value = resource(
            id="seti_new", client_secret="seti_new_secret_test", customer="cus_owner", status="requires_payment_method", livemode=False, payment_method=None,
        )
        self.stripe_client.v1.setup_intents.retrieve.return_value = resource(
            id=self.card.stripe_setup_intent_id, customer="cus_owner", status="succeeded", livemode=False, payment_method=self.card.stripe_payment_method_id,
        )
        self.stripe_client.v1.payment_methods.retrieve.return_value = resource(
            id=self.card.stripe_payment_method_id, customer="cus_owner", type="card", livemode=False,
            card={"brand": "visa", "last4": "4242", "exp_month": 12, "exp_year": 2039},
        )
        self.stripe_client.v1.payment_intents.create.return_value = resource(
            id="pi_new", client_secret="pi_new_secret_test", customer="cus_owner", status="requires_confirmation", livemode=False,
            amount=50000, amount_received=0, currency="mxn", payment_method=self.card.stripe_payment_method_id,
        )
        self.stripe_client.v1.payment_intents.retrieve.return_value = self.stripe_client.v1.payment_intents.create.return_value

    def make_card(self, user=None, active=True):
        owner = user or self.user
        identifier = uuid4().hex
        return PaymentCard.objects.create(
            usuario=owner, request_id=uuid4(), stripe_customer_id="cus_owner" if owner.pk == self.user.pk else "cus_other",
            stripe_setup_intent_id=f"seti_{identifier}", stripe_payment_method_id=f"pm_{identifier}",
            brand="visa", last4="4242", exp_month=12, exp_year=2039,
            verified_at=timezone.now() if active else None, verified_email=owner.email if active else "",
        )

    def post(self, path, payload=None, client=None):
        return (client or self.client).post(path, payload or {}, format="json")

    def request_code(self):
        self.card.verified_at = None
        self.card.verified_email = ""
        self.card.save(update_fields=["verified_at", "verified_email"])
        response = self.post(f"/api/cards/{self.card.pk}/verification/request/")
        self.assertEqual(response.status_code, 200, getattr(response, "data", None))
        code = self.code_sender.call_args.args[2]
        self.assertRegex(code, r"^[0-9]{6}$")
        return {"challenge_id": response.data["challenge_id"], "code": code}

    def confirm_code(self, payload, card=None):
        return self.post(f"/api/cards/{(card or self.card).pk}/verification/confirm/", payload)

    def create_topup(self, **overrides):
        payload = {"amount": "500.00", "card_id": str(self.card.pk), "request_id": str(uuid4()), **overrides}
        return self.post("/api/funds/", payload), payload

    def make_topup(self, **overrides):
        return TopUp.objects.create(
            **{
                "usuario": self.user, "card": self.card, "request_id": uuid4(), "amount": Decimal("500.00"),
                "currency": "mxn", "stripe_payment_intent_id": f"pi_{uuid4().hex}", "stripe_customer_id": "cus_owner",
                **overrides,
            }
        )

    def event(self, topup, kind="payment_intent.succeeded", **changes):
        payment = {
            "id": topup.stripe_payment_intent_id, "object": "payment_intent", "livemode": False,
            "status": "succeeded" if kind.endswith("succeeded") else "requires_payment_method",
            "customer": "cus_owner", "payment_method": self.card.stripe_payment_method_id,
            "amount": 50000, "amount_received": 50000 if kind.endswith("succeeded") else 0,
            "currency": "mxn", "metadata": {"topup_id": str(topup.pk)}, **changes,
        }
        return {"id": f"evt_{uuid4().hex}", "object": "event", "livemode": False, "type": kind, "data": {"object": payment}}

    def webhook(self, event, signature=None):
        payload = json.dumps(event, separators=(",", ":")).encode()
        timestamp = str(int(time.time()))
        digest = hmac.new(settings.STRIPE_WEBHOOK_SECRET.encode(), timestamp.encode() + b"." + payload, hashlib.sha256).hexdigest()
        return APIClient().post(
            "/api/stripe/webhook/", payload, content_type="application/json",
            HTTP_STRIPE_SIGNATURE=signature if signature is not None else f"t={timestamp},v1={digest}",
        )

    def assert_no_credit(self):
        self.user.refresh_from_db()
        self.assertEqual(self.user.cash_balance, Decimal("1000.00"))
        self.assertFalse(Transaction.objects.filter(usuario=self.user).exists())
        self.assertFalse(PaymentEmailOutbox.objects.exists())

    def test_configuration_exposes_only_publishable_key_and_missing_keys_are_graceful(self):
        response = self.client.get("/api/payments/config/")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["configured"])
        self.assertEqual(response.data["publishable_key"], settings.STRIPE_PUBLISHABLE_KEY)
        self.assertNotIn(settings.STRIPE_SECRET_KEY, json.dumps(response.data))
        self.assertNotIn(settings.STRIPE_WEBHOOK_SECRET, json.dumps(response.data))
        with override_settings(STRIPE_SECRET_KEY="", STRIPE_PUBLISHABLE_KEY="", STRIPE_WEBHOOK_SECRET=""):
            response = self.client.get("/api/payments/config/")
            self.assertEqual(response.status_code, 200)
            self.assertFalse(response.data["configured"])
            self.assertEqual(self.post("/api/cards/setup/", {"request_id": str(uuid4())}).status_code, 503)
            self.assertEqual(self.create_topup()[0].status_code, 503)
        self.client_factory.assert_not_called()
        self.assert_no_credit()

    def test_live_credentials_are_refused_before_any_stripe_call(self):
        with override_settings(STRIPE_SECRET_KEY="sk_live_not_allowed", STRIPE_PUBLISHABLE_KEY="pk_live_not_allowed"):
            self.assertFalse(self.client.get("/api/payments/config/").data["configured"])
            self.assertEqual(self.post("/api/cards/setup/", {"request_id": str(uuid4())}).status_code, 503)
            self.assertEqual(self.create_topup()[0].status_code, 503)
        self.client_factory.assert_not_called()
        self.assert_no_credit()

    def test_user_endpoints_require_authentication_and_other_accounts_cards_are_private(self):
        anonymous = APIClient()
        for path in ("/api/cards/", "/api/payments/config/"):
            self.assertEqual(anonymous.get(path).status_code, 403)
        self.assertEqual(self.post("/api/cards/setup/", {"request_id": str(uuid4())}, anonymous).status_code, 403)
        self.assertEqual(self.post("/api/funds/", {"amount": "500.00"}, anonymous).status_code, 403)
        other_card = self.make_card(self.other)
        cards = self.client.get("/api/cards/").data["cards"]
        self.assertNotIn(str(other_card.pk), {str(card["id"]) for card in cards})
        self.assertEqual(self.post(f"/api/cards/{other_card.pk}/verification/request/").status_code, 404)
        self.assertEqual(self.create_topup(card_id=str(other_card.pk))[0].status_code, 404)
        self.assert_no_credit()

    def test_session_mutations_keep_csrf_protection(self):
        client = APIClient(enforce_csrf_checks=True)
        client.force_login(self.user)
        self.user.active_session_key = client.cookies[settings.SESSION_COOKIE_NAME].value
        self.user.save(update_fields=["active_session_key"])
        self.assertEqual(client.get("/api/cards/").status_code, 200)
        for path, payload in (
            ("/api/cards/setup/", {"request_id": str(uuid4())}),
            (f"/api/cards/{self.card.pk}/verification/request/", {}),
            ("/api/funds/", {"amount": "500.00", "card_id": str(self.card.pk), "request_id": str(uuid4())}),
        ):
            with self.subTest(path=path):
                self.assertEqual(self.post(path, payload, client).status_code, 403)
        self.assert_no_credit()

    def test_card_setup_is_idempotent_and_does_not_activate_or_credit(self):
        payload = {"request_id": str(uuid4())}
        first = self.post("/api/cards/setup/", payload)
        self.assertIn(first.status_code, (200, 201), getattr(first, "data", None))
        self.stripe_client.v1.setup_intents.retrieve.return_value = self.stripe_client.v1.setup_intents.create.return_value
        second = self.post("/api/cards/setup/", payload)
        self.assertIn(second.status_code, (200, 201))
        self.assertEqual(first.data["card"]["id"], second.data["card"]["id"])
        self.assertEqual(second.data["card"]["status"], "pending")
        self.assertEqual(PaymentCard.objects.filter(usuario=self.user, request_id=payload["request_id"]).count(), 1)
        arguments = self.stripe_client.v1.setup_intents.create.call_args.args[0]
        self.assertEqual(arguments["allowed_payment_method_types"], ["card"])
        self.assertNotIn("payment_method_types", arguments)
        self.assert_no_credit()

    def test_verified_stripe_setup_still_requires_own_single_use_email_code(self):
        challenge = self.request_code()
        row = CardVerification.objects.get(card=self.card)
        self.assertNotEqual(row.code_digest, challenge["code"])
        self.assertNotIn(challenge["code"], json.dumps(self.client.get("/api/cards/").data))
        self.assertEqual(self.client.get("/api/cards/").data["cards"][0]["status"], "pending")
        response = self.confirm_code(challenge)
        self.assertEqual(response.status_code, 200, getattr(response, "data", None))
        self.assertEqual(response.data["card"]["status"], "active")
        row.refresh_from_db()
        self.assertIsNotNone(row.consumed_at)
        self.assertIn(self.confirm_code(challenge).status_code, (400, 409))
        self.assert_no_credit()

    def test_wrong_code_attempts_persist_and_exhausted_code_cannot_activate(self):
        challenge = self.request_code()
        wrong = "111111" if challenge["code"] != "111111" else "222222"
        for attempt in range(1, 6):
            response = self.confirm_code({**challenge, "code": wrong})
            self.assertIn(response.status_code, (400, 429))
            self.assertEqual(CardVerification.objects.get(card=self.card).attempts, attempt)
        self.assertIn(self.confirm_code(challenge).status_code, (400, 429))
        self.card.refresh_from_db()
        self.assertIsNone(self.card.verified_at)

    def test_expired_code_or_changed_email_cannot_activate_card(self):
        for reason in ("expired", "changed-email"):
            with self.subTest(reason=reason):
                if reason == "changed-email":
                    CardVerification.objects.filter(card=self.card).update(sent_at=timezone.now() - timedelta(seconds=61))
                challenge = self.request_code()
                if reason == "expired":
                    CardVerification.objects.filter(card=self.card).update(expires_at=timezone.now() - timedelta(seconds=1))
                else:
                    self.user.email = "new-owner@example.com"
                    self.user.save(update_fields=["email"])
                self.assertEqual(self.confirm_code(challenge).status_code, 400)
                self.card.refresh_from_db()
                self.assertIsNone(self.card.verified_at)

    def test_resend_cooldown_prevents_repeated_emails(self):
        self.request_code()
        response = self.post(f"/api/cards/{self.card.pk}/verification/request/")
        self.assertEqual(response.status_code, 429)
        self.code_sender.assert_called_once()

    def test_code_cannot_be_used_for_another_card(self):
        challenge = self.request_code()
        other_card = self.make_card(active=False)
        self.assertEqual(self.confirm_code(challenge, card=other_card).status_code, 400)
        other_card.refresh_from_db()
        self.assertIsNone(other_card.verified_at)

    def test_setup_for_other_customer_or_live_mode_cannot_request_code(self):
        original = self.stripe_client.v1.setup_intents.retrieve.return_value.to_dict()
        for changes in ({"customer": "cus_other"}, {"livemode": True}, {"status": "requires_payment_method"}):
            with self.subTest(changes=changes):
                self.stripe_client.v1.setup_intents.retrieve.return_value = resource(**{**original, **changes})
                response = self.post(f"/api/cards/{self.card.pk}/verification/request/")
                self.assertIn(response.status_code, (400, 409))
        self.code_sender.assert_not_called()

    def test_delivery_failure_does_not_verify_card_or_lose_resend_opportunity(self):
        self.card.verified_at = None
        self.card.verified_email = ""
        self.card.save(update_fields=["verified_at", "verified_email"])
        self.code_sender.side_effect = EmailDeliveryError("Email unavailable")
        self.assertEqual(self.post(f"/api/cards/{self.card.pk}/verification/request/").status_code, 503)
        self.card.refresh_from_db()
        self.assertIsNone(self.card.verified_at)
        self.code_sender.side_effect = None
        self.assertEqual(self.post(f"/api/cards/{self.card.pk}/verification/request/").status_code, 200)

    def test_pending_expired_disabled_or_email_changed_cards_cannot_fund(self):
        variants = (
            {"verified_at": None}, {"exp_year": 2000}, {"disabled_at": timezone.now()}, {"verified_email": "previous@example.com"},
        )
        for changes in variants:
            with self.subTest(changes=changes):
                card = self.make_card()
                for field, value in changes.items():
                    setattr(card, field, value)
                card.save(update_fields=list(changes))
                self.assertIn(self.create_topup(card_id=str(card.pk))[0].status_code, (400, 404, 409))
        self.stripe_client.v1.payment_intents.create.assert_not_called()
        self.assert_no_credit()

    def test_topup_creation_uses_saved_card_and_centavos_without_crediting(self):
        response, payload = self.create_topup()
        self.assertIn(response.status_code, (200, 201), getattr(response, "data", None))
        topup = TopUp.objects.get(request_id=payload["request_id"])
        self.assertEqual(topup.amount, Decimal("500.00"))
        self.assertEqual(response.data["topup"]["status"], "pending")
        arguments = self.stripe_client.v1.payment_intents.create.call_args.args[0]
        self.assertEqual(arguments["amount"], 50000)
        self.assertEqual(arguments["currency"], "mxn")
        self.assertEqual(arguments["customer"], "cus_owner")
        self.assertEqual(arguments["payment_method"], self.card.stripe_payment_method_id)
        self.assertEqual(arguments["allowed_payment_method_types"], ["card"])
        self.assertNotIn("payment_method_types", arguments)
        self.assertEqual(str(arguments["metadata"]["topup_id"]), str(topup.pk))
        self.assert_no_credit()

    def test_invalid_amounts_and_old_direct_funds_request_do_not_grant_balance(self):
        for amount in ("0", "-1", "0.01", "9.99", "1000000.00", "NaN", "10.001"):
            with self.subTest(amount=amount):
                self.assertEqual(self.create_topup(amount=amount)[0].status_code, 400)
        self.assertEqual(self.post("/api/funds/", {"amount": "500"}).status_code, 400)
        self.assert_no_credit()

    def test_repeating_same_request_is_one_topup_and_changed_amount_is_rejected(self):
        first, payload = self.create_topup()
        self.assertIn(first.status_code, (200, 201))
        second = self.post("/api/funds/", payload)
        self.assertIn(second.status_code, (200, 201))
        self.assertEqual(first.data["topup"]["id"], second.data["topup"]["id"])
        changed = self.post("/api/funds/", {**payload, "amount": "600.00"})
        self.assertIn(changed.status_code, (400, 409))
        self.assertEqual(TopUp.objects.filter(usuario=self.user).count(), 1)
        self.assert_no_credit()

    def test_network_timeout_retry_reuses_the_durable_topup_request(self):
        self.stripe_client.v1.payment_intents.create.side_effect = stripe.APIConnectionError("Simulated timeout")
        failed, payload = self.create_topup()
        self.assertEqual(failed.status_code, 503)
        pending = TopUp.objects.get(request_id=payload["request_id"])
        self.stripe_client.v1.payment_intents.create.side_effect = None
        retried = self.post("/api/funds/", payload)
        self.assertIn(retried.status_code, (200, 201))
        self.assertEqual(str(pending.pk), str(retried.data["topup"]["id"]))
        self.assertEqual(TopUp.objects.count(), 1)
        self.assert_no_credit()

    def test_topup_status_is_private_and_reading_it_does_not_credit(self):
        topup = self.make_topup()
        response = self.client.get(f"/api/funds/{topup.pk}/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["topup"]["status"], "pending")
        self.client.force_authenticate(self.other)
        self.assertEqual(self.client.get(f"/api/funds/{topup.pk}/").status_code, 404)
        self.assert_no_credit()

    def test_signed_success_credits_once_even_for_distinct_duplicate_events(self):
        topup = self.make_topup()
        event = self.event(topup)
        for delivered in (event, event, self.event(topup)):
            self.assertEqual(self.webhook(delivered).status_code, 200)
        self.user.refresh_from_db()
        self.other.refresh_from_db()
        topup.refresh_from_db()
        self.assertEqual(self.user.cash_balance, Decimal("1500.00"))
        self.assertEqual(self.other.cash_balance, Decimal("55.00"))
        self.assertEqual(topup.status, "succeeded")
        self.assertIsNotNone(topup.credited_at)
        self.assertIsNotNone(topup.transaction_id)
        self.assertEqual(Transaction.objects.filter(usuario=self.user, tipo="deposit").count(), 1)
        self.assertEqual(PaymentEmailOutbox.objects.count(), 1)

    def test_missing_or_invalid_signature_is_rejected_without_credit(self):
        topup = self.make_topup()
        for signature in ("", "t=1,v1=not-a-signature"):
            with self.subTest(signature=signature):
                self.assertEqual(self.webhook(self.event(topup), signature=signature).status_code, 400)
        self.assert_no_credit()

    def test_signed_mismatched_payment_fields_never_credit(self):
        topup = self.make_topup()
        variants = (
            {"amount": 49999}, {"amount_received": 49999}, {"currency": "usd"}, {"customer": "cus_other"},
            {"payment_method": "pm_other"}, {"livemode": True}, {"metadata": {"topup_id": str(uuid4())}},
            {"id": "pi_unknown"}, {"status": "requires_confirmation"},
        )
        for changes in variants:
            with self.subTest(changes=changes):
                response = self.webhook(self.event(topup, **changes))
                self.assertIn(response.status_code, (200, 400, 409))
                self.assert_no_credit()

    def test_failed_payment_does_not_credit_and_cannot_downgrade_an_accredited_topup(self):
        topup = self.make_topup()
        self.assertEqual(self.webhook(self.event(topup, kind="payment_intent.payment_failed")).status_code, 200)
        self.assert_no_credit()
        self.assertEqual(self.webhook(self.event(topup)).status_code, 200)
        self.assertEqual(self.webhook(self.event(topup, kind="payment_intent.payment_failed")).status_code, 200)
        topup.refresh_from_db()
        self.user.refresh_from_db()
        self.assertEqual(topup.status, "succeeded")
        self.assertEqual(self.user.cash_balance, Decimal("1500.00"))
        self.assertEqual(Transaction.objects.count(), 1)

    def test_unknown_event_is_acknowledged_without_touching_balances(self):
        response = self.webhook({"id": "evt_unused", "livemode": False, "type": "customer.updated", "data": {"object": {"id": "cus_owner"}}})
        self.assertEqual(response.status_code, 200)
        self.assert_no_credit()

    def test_email_failure_is_durable_and_retry_never_repeats_the_credit(self):
        topup = self.make_topup()
        self.email_sender.side_effect = EmailDeliveryError("Simulated email outage")
        self.assertEqual(self.webhook(self.event(topup)).status_code, 200)
        call_command("send_payment_emails", stdout=StringIO())
        outbox = PaymentEmailOutbox.objects.get()
        self.assertIsNone(outbox.sent_at)
        self.assertEqual(outbox.attempts, 1)
        self.user.refresh_from_db()
        self.assertEqual(self.user.cash_balance, Decimal("1500.00"))
        self.email_sender.side_effect = None
        # A retry should remain possible after a temporary provider outage.
        if hasattr(outbox, "next_attempt_at"):
            PaymentEmailOutbox.objects.filter(pk=outbox.pk).update(next_attempt_at=timezone.now() - timedelta(seconds=1))
        call_command("send_payment_emails", stdout=StringIO())
        outbox.refresh_from_db()
        self.assertIsNotNone(outbox.sent_at)
        self.assertEqual(outbox.attempts, 2)
        call_command("send_payment_emails", stdout=StringIO())
        self.assertEqual(self.email_sender.call_count, 2)
        first_key = self.email_sender.call_args_list[0].kwargs["idempotency_key"]
        self.assertEqual(first_key, self.email_sender.call_args_list[1].kwargs["idempotency_key"])
        self.assertEqual(Transaction.objects.count(), 1)
        self.user.refresh_from_db()
        self.assertEqual(self.user.cash_balance, Decimal("1500.00"))
