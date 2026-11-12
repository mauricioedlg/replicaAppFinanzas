"""Retry durable payment receipts independently of payment processing."""
import time

from django.core.management.base import BaseCommand, CommandError
from django.db import DatabaseError, close_old_connections

from core.payment_emails import deliver_pending_payment_emails


class Command(BaseCommand):
    help = "Envía comprobantes pendientes de recargas; --watch mantiene un trabajador de reintentos."

    def add_arguments(self, parser):
        parser.add_argument("--watch", action="store_true")
        parser.add_argument("--interval", type=float, default=10)
        parser.add_argument("--limit", type=int, default=25)

    def handle(self, *args, **options):
        if not 1 <= options["interval"] <= 60 or not 1 <= options["limit"] <= 1000:
            raise CommandError("El intervalo debe estar entre 1 y 60 segundos y el límite entre 1 y 1000.")
        try:
            while True:
                if options["watch"]:
                    close_old_connections()
                try:
                    result = deliver_pending_payment_emails(limit=options["limit"])
                except (DatabaseError, OSError):
                    if not options["watch"]:
                        raise CommandError("No se pudieron consultar los comprobantes pendientes.") from None
                    self.stderr.write("El trabajador de comprobantes reintentará la conexión.")
                    time.sleep(options["interval"])
                    continue
                if result["sent"] or result["failed"] or not options["watch"]:
                    self.stdout.write(f"Comprobantes enviados: {result['sent']}; pendientes tras fallo: {result['failed']}.")
                if not options["watch"]:
                    return
                time.sleep(options["interval"])
        except KeyboardInterrupt:
            self.stdout.write("Trabajador de comprobantes detenido.")
