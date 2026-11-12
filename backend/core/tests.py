from datetime import timedelta
from decimal import Decimal
from io import StringIO
from unittest.mock import patch

from django.core.cache import cache
from django.core.management import call_command
from django.db import IntegrityError, transaction
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from .demo import DEMO_USER, HOLDINGS, STOCKS, TRANSACTIONS
from .models import Holding, Stock, Transaction, User
from .serializers import UserSerializer
from .services import deposit_funds, execute_trade


FAST_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher", "django.contrib.auth.hashers.PBKDF2PasswordHasher"]


@override_settings(PASSWORD_HASHERS=FAST_HASHERS)
class FinanceAPITests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="investor", email="investor@example.com", password="SafeExample492!", nombre="Persona de prueba", cash_balance="1000.00")
        self.other = User.objects.create_user(username="other", email="other@example.com", password="SafeExample492!", nombre="Otra persona", cash_balance="9000.00")
        self.stock = Stock.objects.create(symbol="TEST", nombre="Example stock", sector="Tecnología", precio="100.00", cambio_porcentual="1.25")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def trade(self, side="buy", quantity="1", **extra):
        return self.client.post("/api/trades/", {"stock_id": self.stock.pk, "side": side, "quantity": quantity, **extra}, format="json")

    def test_private_endpoints_require_session(self):
        anonymous = APIClient()
        for path in ["auth/me", "stocks", "dashboard", "portfolio", "transactions"]:
            self.assertEqual(anonymous.get(f"/api/{path}/").status_code, 403)

    def test_dashboard_values_are_calculated_from_current_owned_shares(self):
        Holding.objects.create(usuario=self.user, accion=self.stock, quantity="2.500000", invested="200.00")
        response = self.client.get("/api/dashboard/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["summary"], {
            "portfolio_value": "250.00", "invested": "200.00", "profit": "50.00", "profit_percent": "25.00",
            "cash_balance": "1000.00", "total_equity": "1250.00", "assets_count": 1,
        })
        self.assertEqual(response.data["holdings"][0]["allocation"], "100.00")
        self.assertNotIn("password", response.data["user"])

    def test_buy_updates_balance_cost_basis_and_ledger(self):
        response = self.trade(quantity="2.500000", price="0.01", usuario=self.other.pk)
        self.assertEqual(response.status_code, 201)
        self.user.refresh_from_db()
        self.other.refresh_from_db()
        self.assertEqual(self.user.cash_balance, Decimal("750.00"))
        self.assertEqual(self.other.cash_balance, Decimal("9000.00"))
        holding = Holding.objects.get(usuario=self.user)
        self.assertEqual(holding.quantity, Decimal("2.5"))
        self.assertEqual(holding.invested, Decimal("250.00"))
        record = Transaction.objects.get()
        self.assertEqual(record.usuario, self.user)
        self.assertEqual(record.precio_unitario, Decimal("100.00"))
        self.assertEqual(record.monto, Decimal("250.00"))

    def test_buy_rejects_insufficient_balance_without_partial_update(self):
        self.assertEqual(self.trade(quantity="11").status_code, 400)
        self.user.refresh_from_db()
        self.assertEqual(self.user.cash_balance, Decimal("1000.00"))
        self.assertFalse(Holding.objects.exists())
        self.assertFalse(Transaction.objects.exists())

    def test_sequential_purchases_cannot_spend_the_balance_twice(self):
        self.assertEqual(self.trade(quantity="8").status_code, 201)
        self.assertEqual(self.trade(quantity="8").status_code, 400)
        self.user.refresh_from_db()
        self.assertEqual(self.user.cash_balance, Decimal("200.00"))
        self.assertEqual(Transaction.objects.count(), 1)

    def test_sell_reduces_cost_proportionally_and_removes_empty_position(self):
        Holding.objects.create(usuario=self.user, accion=self.stock, quantity="4", invested="320.00")
        self.assertEqual(self.trade(side="sell", quantity="1.5").status_code, 201)
        holding = Holding.objects.get(usuario=self.user)
        self.assertEqual(holding.quantity, Decimal("2.5"))
        self.assertEqual(holding.invested, Decimal("200.00"))
        self.assertEqual(self.trade(side="sell", quantity="2.5").status_code, 201)
        self.assertFalse(Holding.objects.filter(usuario=self.user).exists())
        self.user.refresh_from_db()
        self.assertEqual(self.user.cash_balance, Decimal("1400.00"))

    def test_overselling_and_other_accounts_holdings_are_rejected(self):
        Holding.objects.create(usuario=self.other, accion=self.stock, quantity="20", invested="2000.00")
        self.assertEqual(self.trade(side="sell", quantity="1").status_code, 400)
        Holding.objects.create(usuario=self.user, accion=self.stock, quantity="1", invested="100.00")
        self.assertEqual(self.trade(side="sell", quantity="1.000001").status_code, 400)
        self.assertFalse(Transaction.objects.exists())

    def test_fractional_money_is_rounded_once_with_half_up(self):
        response = self.trade(quantity="0.000050")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["transaction"]["monto"], "0.01")
        self.assertEqual(response.data["cash_balance"], "999.99")

    def test_invalid_trade_quantities_are_rejected(self):
        for quantity in ["0", "-1", "0.000001", "0.0000001", "NaN", "Infinity", "1000000000000"]:
            with self.subTest(quantity=quantity):
                self.assertEqual(self.trade(quantity=quantity).status_code, 400)
        self.assertFalse(Transaction.objects.exists())

    def test_trade_rejects_extreme_decimal_product_without_server_error(self):
        self.stock.precio = Decimal("1000000000000000.00")
        self.stock.save(update_fields=["precio"])
        self.assertEqual(self.trade(quantity="999999999999.999999").status_code, 400)
        self.assertFalse(Transaction.objects.exists())

    def test_trade_rolls_back_if_ledger_write_fails(self):
        with patch("core.services.Transaction.objects.create", side_effect=RuntimeError("ledger unavailable")):
            with self.assertRaises(RuntimeError):
                execute_trade(self.user, self.stock.pk, "buy", Decimal("2"))
        self.user.refresh_from_db()
        self.assertEqual(self.user.cash_balance, Decimal("1000.00"))
        self.assertFalse(Holding.objects.exists())

    @override_settings(STRIPE_SECRET_KEY="", STRIPE_PUBLISHABLE_KEY="", STRIPE_WEBHOOK_SECRET="")
    def test_funds_endpoint_cannot_credit_balance_without_a_verified_card_and_payment(self):
        response = self.client.post("/api/funds/", {"amount": "150.25"}, format="json")
        self.assertIn(response.status_code, [400, 503])
        self.user.refresh_from_db()
        self.assertEqual(self.user.cash_balance, Decimal("1000.00"))
        self.assertFalse(Transaction.objects.filter(usuario=self.user, tipo="deposit").exists())

    def test_transactions_and_portfolio_never_leak_other_users_data(self):
        Transaction.objects.create(usuario=self.other, tipo="deposit", descripcion="Private other deposit", monto="500.00", fecha=timezone.now())
        Holding.objects.create(usuario=self.other, accion=self.stock, quantity="9", invested="900.00")
        self.assertEqual(self.client.get(f"/api/transactions/?user_id={self.other.pk}").data, [])
        self.assertEqual(self.client.get(f"/api/portfolio/?user_id={self.other.pk}").data["holdings"], [])

    def test_transaction_filters_validate_dates_and_apply_to_own_data(self):
        now = timezone.now()
        Transaction.objects.create(usuario=self.user, tipo="deposit", descripcion="Old deposit", monto="50.00", fecha=now - timedelta(days=5))
        self.trade()
        self.assertEqual(len(self.client.get("/api/transactions/?type=buy&search=TEST").data), 1)
        self.assertEqual(len(self.client.get(f"/api/transactions/?start={timezone.localdate()}").data), 1)
        self.assertEqual(self.client.get("/api/transactions/?start=2026-02-30").status_code, 400)
        self.assertEqual(self.client.get("/api/transactions/?start=2026-12-31&end=2026-01-01").status_code, 400)
        self.assertEqual(self.client.get("/api/transactions/?type=invalid").status_code, 400)

    def test_profile_can_change_preferences_but_cannot_grant_money_or_staff(self):
        response = self.client.patch("/api/auth/me/", {"nombre": "Nombre nuevo", "dark_mode": True, "notifications": False, "cash_balance": "999999.00", "is_staff": True, "username": "hacker"}, format="json")
        self.assertEqual(response.status_code, 200)
        self.user.refresh_from_db()
        self.assertEqual(self.user.nombre, "Nombre nuevo")
        self.assertTrue(self.user.dark_mode)
        self.assertFalse(self.user.notifications)
        self.assertFalse(self.user.is_staff)
        self.assertEqual(self.user.username, "investor")
        self.assertEqual(self.user.cash_balance, Decimal("1000.00"))

    def test_stale_profile_save_cannot_overwrite_a_committed_deposit(self):
        stale_user = User.objects.get(pk=self.user.pk)
        serializer = UserSerializer(stale_user, data={"nombre": "Perfil actualizado"}, partial=True)
        self.assertTrue(serializer.is_valid())
        deposit_funds(self.user, Decimal("125.50"))
        serializer.save()
        self.user.refresh_from_db()
        self.assertEqual(self.user.cash_balance, Decimal("1125.50"))
        self.assertEqual(self.user.nombre, "Perfil actualizado")
        self.assertEqual(serializer.data["cash_balance"], "1125.50")

    def test_case_insensitive_email_uniqueness_in_profile_and_database(self):
        self.assertEqual(self.client.patch("/api/auth/me/", {"email": self.other.email.upper()}, format="json").status_code, 400)
        with self.assertRaises(IntegrityError), transaction.atomic():
            User.objects.create(username="third", email=self.other.email.upper(), nombre="Duplicate")

    def test_stock_search_supports_symbol_and_name(self):
        self.assertEqual(self.client.get("/api/stocks/?search=test").data[0]["symbol"], "TEST")
        self.assertEqual(self.client.get("/api/stocks/?search=unknown").data, [])


@override_settings(PASSWORD_HASHERS=FAST_HASHERS, RESEND_API_KEY="re_auth_tests_only", RESEND_FROM_EMAIL="Folio <security@example.com>")
class AuthenticationTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="person", email="person@example.com", password="SafeExample492!", nombre="Persona")
        self.client = APIClient(enforce_csrf_checks=True)
        self.send_login_code = patch("core.login_verification.send_login_verification_code").start()
        self.addCleanup(patch.stopall)

    def csrf_post(self, path, data):
        self.client.get("/api/auth/csrf/")
        return self.client.post(path, data, format="json", HTTP_X_CSRFTOKEN=self.client.cookies["csrftoken"].value)

    def verify_login(self, pending):
        self.assertTrue(pending.data["verification_required"])
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 403)
        code = self.send_login_code.call_args.args[1]
        return self.csrf_post("/api/auth/login/verify/", {"challenge_id": pending.data["challenge_id"], "code": code})

    def test_anonymous_login_and_registration_require_csrf(self):
        for path in ["login", "register"]:
            self.assertEqual(self.client.post(f"/api/auth/{path}/", {}, format="json").status_code, 403)

    def test_login_accepts_case_insensitive_email_and_username_and_logout_ends_session(self):
        response = self.csrf_post("/api/auth/login/", {"identifier": "PERSON@EXAMPLE.COM", "password": "SafeExample492!"})
        self.assertEqual(response.status_code, 200)
        response = self.verify_login(response)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["user"]["id"], self.user.pk)
        self.assertNotIn("password", response.data["user"])
        self.assertTrue(self.client.cookies["sessionid"]["httponly"])
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 200)
        self.assertEqual(self.client.post("/api/funds/", {"amount": "10"}, format="json").status_code, 403)
        token = self.client.cookies["csrftoken"].value
        self.assertEqual(self.client.post("/api/auth/logout/", {}, format="json", HTTP_X_CSRFTOKEN=token).status_code, 200)
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 403)
        from .models import LoginChallenge
        LoginChallenge.objects.filter(user=self.user).update(sent_at=timezone.now() - timedelta(seconds=61))
        self.assertEqual(self.csrf_post("/api/auth/login/", {"identifier": "PERSON", "password": "SafeExample492!"}).status_code, 200)

    def test_registration_validates_hashes_and_case_insensitive_uniqueness(self):
        payload = {"username": "newperson", "email": "NEW@EXAMPLE.COM", "nombre": "Persona nueva", "telefono": "81 1234 5678", "password": "AnotherSafe492!"}
        response = self.csrf_post("/api/auth/register/", payload)
        self.assertEqual(response.status_code, 201)
        account = User.objects.get(username="newperson")
        self.assertEqual(account.email, "new@example.com")
        self.assertNotEqual(account.password, payload["password"])
        self.assertTrue(account.check_password(payload["password"]))
        self.assertEqual(account.cash_balance, Decimal("0.00"))
        verified = self.verify_login(response)
        self.assertEqual(verified.status_code, 200)
        self.assertEqual(verified.data["user"]["id"], account.pk)
        self.assertEqual(self.csrf_post("/api/auth/register/", {**payload, "username": "NEWPERSON", "email": "unique@example.com"}).status_code, 400)
        self.assertEqual(self.csrf_post("/api/auth/register/", {**payload, "username": "different"}).status_code, 400)

    def test_registration_rejects_weak_password_and_email_shaped_username(self):
        payload = {"username": "validuser", "email": "new@example.com", "nombre": "Persona", "password": "12345678"}
        self.assertEqual(self.csrf_post("/api/auth/register/", payload).status_code, 400)
        self.assertEqual(self.csrf_post("/api/auth/register/", {**payload, "username": "person@example.com", "password": "SafeExample492!"}).status_code, 400)

    def test_login_rate_limit_applies_even_with_an_authenticated_session(self):
        response = self.csrf_post("/api/auth/login/", {"identifier": "person", "password": "SafeExample492!"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.verify_login(response).status_code, 200)
        for _ in range(9):
            response = self.csrf_post("/api/auth/login/", {"identifier": "person", "password": "IncorrectExample!"})
            self.assertEqual(response.status_code, 400)
        response = self.csrf_post("/api/auth/login/", {"identifier": "person", "password": "IncorrectExample!"})
        self.assertEqual(response.status_code, 429)


class DemoSeedTests(TestCase):
    def test_seed_is_consistent_idempotent_and_preserves_existing_trades(self):
        call_command("seed_demo", stdout=StringIO())
        user = User.objects.get(username=DEMO_USER["username"])
        self.assertEqual(user.nombre, "Mauricio Estrada De la Garza")
        self.assertEqual(user.password, DEMO_USER["password"])
        self.assertTrue(user.password.startswith("pbkdf2_sha256$"))
        self.assertEqual(Stock.objects.count(), len(STOCKS))
        self.assertEqual(Holding.objects.count(), len(HOLDINGS))
        self.assertEqual(Transaction.objects.count(), len(TRANSACTIONS))
        ledger_balance = sum((row.monto if row.tipo in ["sell", "deposit"] else -row.monto for row in user.transactions.all()), Decimal("0"))
        self.assertEqual(ledger_balance, user.cash_balance)
        symbol, quantity, _ = HOLDINGS[0]
        execute_trade(user, Stock.objects.get(symbol=symbol).pk, "sell", Decimal("1"))
        user.refresh_from_db()
        balance_after_sale = user.cash_balance
        call_command("seed_demo", stdout=StringIO())
        user.refresh_from_db()
        self.assertEqual(user.cash_balance, balance_after_sale)
        self.assertEqual(Transaction.objects.count(), len(TRANSACTIONS) + 1)
        self.assertEqual(Holding.objects.get(usuario=user, accion__symbol=symbol).quantity, Decimal(quantity) - 1)
