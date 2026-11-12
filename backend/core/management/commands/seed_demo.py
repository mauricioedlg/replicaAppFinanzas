from datetime import timedelta
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from core.demo import DEMO_USER, HOLDINGS, STOCKS, TRANSACTIONS
from core.models import Holding, Stock, Transaction, User


class Command(BaseCommand):
    help = "Carga 30 emisoras BMV y ejemplos. --replace-with-bmv sustituye el catálogo y portafolio anteriores de Mauricio."

    def add_arguments(self, parser):
        parser.add_argument(
            "--replace-with-bmv", action="store_true",
            help="Sustituye las acciones ajenas al catálogo BMV y los ejemplos financieros de Mauricio, conservando su cuenta. Una vez migrado, conserva las nuevas operaciones.",
        )

    @transaction.atomic
    def handle(self, *args, **options):
        symbols = [stock[0] for stock in STOCKS]
        accounts = list(User.objects.select_for_update().filter(
            Q(username__iexact=DEMO_USER["username"]) | Q(email__iexact=DEMO_USER["email"])
        ))
        user = accounts[0] if accounts else None
        # Materialize and lock before changing anything. Never erase another
        # account's positions or history to remove a referenced stock.
        retired_ids = list(Stock.objects.select_for_update().exclude(symbol__in=symbols).values_list("pk", flat=True))
        replacing = options["replace_with_bmv"] and bool(retired_ids)
        if replacing:
            if len(accounts) > 1:
                raise CommandError("El usuario y correo de Mauricio corresponden a cuentas distintas; no se modificó la base.")
            holdings = Holding.objects.filter(accion_id__in=retired_ids)
            movements = Transaction.objects.filter(accion_id__in=retired_ids)
            if user:
                holdings = holdings.exclude(usuario=user)
                movements = movements.exclude(usuario=user)
            if holdings.exists() or movements.exists():
                raise CommandError("Otras cuentas tienen posiciones o movimientos en las acciones anteriores; no se modificó la base.")
            if user:
                user.holdings.all().delete()
                user.transactions.all().delete()
                user.cash_balance = DEMO_USER["cash_balance"]
                user.save(update_fields=["cash_balance"])
            Stock.objects.filter(pk__in=retired_ids).delete()
        stocks = {}
        for symbol, name, sector, price, change, color in STOCKS:
            stocks[symbol], _ = Stock.objects.get_or_create(symbol=symbol, defaults={"nombre": name, "sector": sector, "precio": price, "cambio_porcentual": change, "color": color})
        if user and not replacing:
            self.stdout.write(self.style.SUCCESS(f"{len(STOCKS)} acciones BMV disponibles. La cuenta ya existe; se conservaron sus datos y movimientos."))
            if retired_ids:
                self.stdout.write(self.style.WARNING("Aún hay acciones del catálogo anterior. Usa seed_demo --replace-with-bmv para sustituirlas junto con los ejemplos de Mauricio."))
            return
        if not user:
            user = User.objects.create(**DEMO_USER)
        for symbol, quantity, invested in HOLDINGS:
            Holding.objects.create(usuario=user, accion=stocks[symbol], quantity=quantity, invested=invested)
        now = timezone.now()
        for kind, symbol, quantity, unit_price, amount, days_ago in TRANSACTIONS:
            stock = stocks[symbol] if symbol else None
            label = "Depósito de saldo de simulación" if kind == "deposit" else f"{'Compra' if kind == 'buy' else 'Venta'} de {quantity} títulos de {stock.nombre}"
            Transaction.objects.create(usuario=user, accion=stock, tipo=kind, descripcion=label, cantidad=quantity, precio_unitario=unit_price, monto=amount, fecha=now - timedelta(days=days_ago))
        self.stdout.write(self.style.SUCCESS(f"Catálogo BMV listo: {len(STOCKS)} acciones, {len(HOLDINGS)} posiciones y {len(TRANSACTIONS)} movimientos de ejemplo para Mauricio."))
