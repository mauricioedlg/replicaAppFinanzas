from collections import defaultdict
from decimal import Decimal
from io import StringIO

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from .demo import DEMO_USER, HOLDINGS, STOCKS, TRANSACTIONS
from .models import Holding, Stock, Transaction, User
from .services import execute_trade, money


PORTFOLIO_SYMBOLS = {"CEMEXCPO", "GFNORTEO", "FEMSAUBD", "WALMEX", "LIVEPOLC-1", "AC"}


class BMVCatalogTests(TestCase):
    def setUp(self):
        call_command("seed_demo", stdout=StringIO())
        self.user = User.objects.get(username=DEMO_USER["username"])
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_catalog_and_portfolio_contain_the_requested_companies(self):
        response = self.client.get("/api/stocks/")
        self.assertEqual(response.status_code, 200)
        symbols = {stock["symbol"] for stock in response.data}
        self.assertEqual(len(symbols), 30)
        self.assertEqual(symbols, {stock[0] for stock in STOCKS})
        self.assertFalse(symbols & {"AAPL", "MSFT", "GOOGL", "META", "KO", "MCD", "TSLA", "AMZN", "NFLX"})
        self.assertTrue(all(len(symbol) <= Stock._meta.get_field("symbol").max_length for symbol in symbols))
        self.assertEqual(set(self.user.holdings.values_list("accion__symbol", flat=True)), PORTFOLIO_SYMBOLS)
        for side in ("buy", "sell"):
            self.assertEqual(
                set(self.user.transactions.filter(tipo=side).values_list("accion__symbol", flat=True)),
                PORTFOLIO_SYMBOLS,
            )
            self.assertEqual(self.user.transactions.filter(tipo=side).count(), 6)

    def test_ledger_reconciles_cash_quantities_and_average_cost_without_overspending(self):
        balance = Decimal("0")
        quantities = defaultdict(lambda: Decimal("0"))
        costs = defaultdict(lambda: Decimal("0"))
        for row in self.user.transactions.select_related("accion").order_by("fecha", "id"):
            if row.tipo == "deposit":
                self.assertIsNone(row.accion_id)
                balance += row.monto
            else:
                symbol = row.accion.symbol
                self.assertEqual(row.monto, money(row.cantidad * row.precio_unitario))
                if row.tipo == "buy":
                    balance -= row.monto
                    quantities[symbol] += row.cantidad
                    costs[symbol] += row.monto
                else:
                    self.assertGreaterEqual(quantities[symbol], row.cantidad)
                    costs[symbol] -= money(costs[symbol] * row.cantidad / quantities[symbol])
                    quantities[symbol] -= row.cantidad
                    balance += row.monto
            self.assertGreaterEqual(balance, 0)

        self.assertEqual(balance, self.user.cash_balance)
        self.assertEqual(self.user.transactions.count(), 13)
        for holding in self.user.holdings.select_related("accion"):
            self.assertEqual(holding.quantity, quantities.pop(holding.accion.symbol))
            self.assertEqual(holding.invested, costs.pop(holding.accion.symbol))
        self.assertFalse(any(quantities.values()))
        self.assertFalse(any(costs.values()))

    def test_search_finds_mexican_company_names_and_tickers(self):
        for term, expected in (("cemex", "CEMEXCPO"), ("banorte", "GFNORTEO"), ("LIVEPOLC-1", "LIVEPOLC-1")):
            with self.subTest(term=term):
                response = self.client.get("/api/stocks/", {"search": term})
                self.assertEqual(response.status_code, 200)
                self.assertIn(expected, {stock["symbol"] for stock in response.data})

    def test_femsa_and_liverpool_support_buys_and_sales_with_their_series_symbols(self):
        for symbol in ("FEMSAUBD", "LIVEPOLC-1"):
            stock = Stock.objects.get(symbol=symbol)
            before = Holding.objects.get(usuario=self.user, accion=stock)
            quantity_before = before.quantity
            cost_before = before.invested
            self.user.refresh_from_db()
            cash_before = self.user.cash_balance
            amount = money(stock.precio * Decimal("0.125"))

            for side in ("buy", "sell"):
                with self.subTest(symbol=symbol, side=side):
                    response = self.client.post(
                        "/api/trades/", {"stock_id": stock.pk, "side": side, "quantity": "0.125"}, format="json",
                    )
                    self.assertEqual(response.status_code, 201)
                    row = self.user.transactions.order_by("-fecha", "-id").first()
                    self.assertEqual(row.accion_id, stock.pk)
                    self.assertEqual(row.monto, amount)
                    self.assertEqual(row.tipo, side)

            self.user.refresh_from_db()
            holding = Holding.objects.get(usuario=self.user, accion=stock)
            self.assertEqual(self.user.cash_balance, cash_before)
            self.assertEqual(holding.quantity, quantity_before)
            self.assertEqual(
                holding.invested,
                cost_before + amount - money((cost_before + amount) * Decimal("0.125") / (quantity_before + Decimal("0.125"))),
            )


class BMVReplacementTests(TestCase):
    def setUp(self):
        self.user = User.objects.create(
            **{**DEMO_USER, "nombre": "Perfil conservado", "telefono": "555 123 4567", "cash_balance": "820.00"},
            notifications=False, dark_mode=True, active_session_key="existing-session-key",
        )
        self.other = User.objects.create_user(username="other-account", email="other-account@example.com", nombre="Otra cuenta", cash_balance="123.45")
        self.legacy = Stock.objects.create(symbol="AAPL", nombre="Apple", sector="Tecnología", precio="100.00")
        Holding.objects.create(usuario=self.user, accion=self.legacy, quantity="2", invested="180.00")
        now = timezone.now()
        Transaction.objects.create(usuario=self.user, tipo="deposit", descripcion="Depósito anterior", monto="1000.00", fecha=now)
        Transaction.objects.create(usuario=self.user, accion=self.legacy, tipo="buy", descripcion="Compra anterior", cantidad="2", precio_unitario="90.00", monto="180.00", fecha=now)

    def replace(self):
        call_command("seed_demo", replace_with_bmv=True, stdout=StringIO())

    def snapshot(self):
        return {
            model._meta.label: list(model.objects.order_by("pk").values())
            for model in (User, Stock, Holding, Transaction)
        }

    def test_replacement_changes_only_demo_finances_and_preserves_identity_and_other_account(self):
        user_before = User.objects.filter(pk=self.user.pk).values().get()
        other_before = User.objects.filter(pk=self.other.pk).values().get()
        self.replace()

        self.user.refresh_from_db()
        expected_user = {**user_before, "cash_balance": Decimal(DEMO_USER["cash_balance"])}
        self.assertEqual(User.objects.filter(pk=self.user.pk).values().get(), expected_user)
        self.assertEqual(User.objects.filter(pk=self.other.pk).values().get(), other_before)
        self.assertFalse(Stock.objects.filter(pk=self.legacy.pk).exists())
        self.assertEqual(set(Stock.objects.values_list("symbol", flat=True)), {stock[0] for stock in STOCKS})
        self.assertEqual(set(self.user.holdings.values_list("accion__symbol", flat=True)), PORTFOLIO_SYMBOLS)
        self.assertEqual(self.user.transactions.count(), len(TRANSACTIONS))
        self.assertFalse(self.other.holdings.exists())
        self.assertFalse(self.other.transactions.exists())

    def test_default_seed_keeps_existing_portfolio_and_legacy_stocks(self):
        holdings_before = list(self.user.holdings.values())
        transactions_before = list(self.user.transactions.values())
        call_command("seed_demo", stdout=StringIO())
        self.user.refresh_from_db()
        self.assertEqual(self.user.cash_balance, Decimal("820.00"))
        self.assertEqual(list(self.user.holdings.values()), holdings_before)
        self.assertEqual(list(self.user.transactions.values()), transactions_before)
        self.assertTrue(Stock.objects.filter(pk=self.legacy.pk).exists())

    def test_repeating_replacement_after_a_new_trade_preserves_that_trade(self):
        self.replace()
        symbol, quantity, _ = HOLDINGS[0]
        execute_trade(self.user, Stock.objects.get(symbol=symbol).pk, "sell", Decimal(quantity) / 2)
        after_sale = self.snapshot()
        self.replace()
        self.assertEqual(self.snapshot(), after_sale)

    def test_other_accounts_legacy_holding_blocks_replacement_without_partial_changes(self):
        Holding.objects.create(usuario=self.other, accion=self.legacy, quantity="1", invested="90.00")
        before = self.snapshot()
        with self.assertRaises(CommandError):
            self.replace()
        self.assertEqual(self.snapshot(), before)

    def test_other_accounts_legacy_transaction_blocks_replacement_without_partial_changes(self):
        Transaction.objects.create(
            usuario=self.other, accion=self.legacy, tipo="buy", descripcion="Movimiento ajeno", cantidad="1",
            precio_unitario="90.00", monto="90.00", fecha=timezone.now(),
        )
        before = self.snapshot()
        with self.assertRaises(CommandError):
            self.replace()
        self.assertEqual(self.snapshot(), before)
