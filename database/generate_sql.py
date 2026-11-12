r"""Regenerate checked-in PostgreSQL reference schema and sample INSERT statements.

Run from the project root with the backend dependencies installed:
    .venv\Scripts\python.exe database\generate_sql.py

No connection to Neon or another database is opened. Django's PostgreSQL schema
editor collects the application's migration SQL, while fixtures come from demo.py.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DESTINATION = ROOT / "database"
spec = importlib.util.spec_from_file_location("folio_demo", ROOT / "backend" / "core" / "demo.py")
demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)


def literal(value: str | None) -> str:
    return "NULL" if value is None else "'" + str(value).replace("'", "''") + "'"


def number(value: str) -> str:
    return format(Decimal(value), "f")


def generate_seed() -> None:
    user = demo.DEMO_USER
    sql = [
        "-- Folio: datos de ejemplo para PostgreSQL / Neon.",
        "-- Requisito: ejecutar primero python backend/manage.py migrate.",
        "-- Precios ficticios en MXN; las operaciones no son inversiones reales.",
        "-- La cuenta usa un hash PBKDF2 de Django, sin contraseña en texto plano.",
        "-- Se preservan los símbolos existentes y las cuentas ya registradas.",
        "BEGIN;",
        "",
        f"-- 1. Acciones: {len(demo.STOCKS)} emisoras BMV con precios de ejemplo.",
        'INSERT INTO "acciones" ("symbol", "nombre", "sector", "precio", "cambio_porcentual", "color", "fecha_actualizacion")',
        "VALUES",
    ]
    stocks = []
    for symbol, name, sector, price, change, color in demo.STOCKS:
        stocks.append(
            "    (" + ", ".join((literal(symbol), literal(name), literal(sector), number(price), number(change), literal(color), "CURRENT_TIMESTAMP")) + ")"
        )
    sql.extend([",\n".join(stocks), 'ON CONFLICT ("symbol") DO NOTHING;', ""])
    sql.extend([
        "-- 2. Usuario y ejemplos de sus posiciones y transacciones.",
        "-- Si el usuario o correo ya existen, no se modifica su saldo ni historial.",
        "DO $folio_seed$",
        "DECLARE",
        "    demo_user_id bigint;",
        "BEGIN",
        '    INSERT INTO "usuarios" ("password", "last_login", "is_superuser", "username", "first_name", "last_name", "email", "is_staff", "is_active", "date_joined", "nombre", "telefono", "cash_balance", "notifications", "dark_mode", "active_session_key")',
        "    VALUES (" + ", ".join((
            literal(user["password"]), "NULL", "false", literal(user["username"]), "''", "''", literal(user["email"]),
            "false", "true", "CURRENT_TIMESTAMP", literal(user["nombre"]), literal(user["telefono"]), number(user["cash_balance"]), "true", "false", "''",
        )) + ")",
        '    ON CONFLICT DO NOTHING RETURNING "id" INTO demo_user_id;',
        "",
        "    IF demo_user_id IS NULL THEN",
        "        RAISE NOTICE 'La cuenta de ejemplo ya existe (usuario o correo). Se conserva sin cambios.';",
        "        RETURN;",
        "    END IF;",
        "",
        f"    -- 3. Portafolio: {len(demo.HOLDINGS)} posiciones; las relaciones se buscan por símbolo.",
        '    INSERT INTO "portafolio" ("usuario_id", "accion_id", "quantity", "invested")',
        '    SELECT demo_user_id, a."id", examples.quantity, examples.invested',
        "    FROM (VALUES",
    ])
    sql.append(",\n".join("        (" + ", ".join((literal(symbol), number(quantity), number(invested))) + ")" for symbol, quantity, invested in demo.HOLDINGS))
    sql.extend([
        '    ) AS examples(symbol, quantity, invested)',
        '    JOIN "acciones" a ON a."symbol" = examples.symbol;',
        "",
        f"    -- 4. Transacciones: {len(demo.TRANSACTIONS)} movimientos que explican las posiciones y saldo.",
        '    INSERT INTO "transacciones" ("usuario_id", "accion_id", "tipo", "descripcion", "cantidad", "precio_unitario", "monto", "fecha")',
        '    SELECT demo_user_id, a."id", examples.tipo, examples.descripcion, examples.cantidad, examples.precio_unitario, examples.monto, CURRENT_TIMESTAMP - examples.days_ago * INTERVAL \'1 day\'',
        "    FROM (VALUES",
    ])
    transactions = []
    stock_names = {stock[0]: stock[1] for stock in demo.STOCKS}
    for kind, symbol, quantity, unit_price, amount, days in demo.TRANSACTIONS:
        description = "Depósito de saldo de simulación" if kind == "deposit" else f"{'Compra' if kind == 'buy' else 'Venta'} de {quantity} títulos de {stock_names[symbol]}"
        transactions.append("        (" + ", ".join((literal(kind), literal(symbol), literal(description), number(quantity), number(unit_price), number(amount), str(int(days)))) + ")")
    sql.append(",\n".join(transactions))
    sql.extend([
        '    ) AS examples(tipo, symbol, descripcion, cantidad, precio_unitario, monto, days_ago)',
        '    LEFT JOIN "acciones" a ON a."symbol" = examples.symbol;',
        "END;",
        "$folio_seed$;",
        "",
        "COMMIT;",
        "",
    ])
    (DESTINATION / "seed.sql").write_text("\n".join(sql), encoding="utf-8")


def generate_schema() -> None:
    # An isolated development configuration permits loading models without any
    # configured credentials. All DDL is collected, never sent to a database.
    os.environ["USE_SQLITE"] = "true"
    os.environ["DATABASE_URL"] = ""
    os.environ["DEBUG"] = "true"
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    sys.path.insert(0, str(ROOT / "backend"))
    import django
    django.setup()
    from django.db.backends.postgresql.base import DatabaseWrapper
    from django.db import connections
    from django.db.migrations.loader import MigrationLoader

    loader = MigrationLoader(None)
    migration_names = []
    for leaf in loader.graph.leaf_nodes("core"):
        for node in loader.graph.forwards_plan(leaf):
            if node[0] == "core" and node not in migration_names:
                migration_names.append(node)
    migrations = [loader.get_migration(*node) for node in migration_names]
    state = loader.project_state(migrations[0].dependencies)
    wrapper = DatabaseWrapper({"ENGINE": "django.db.backends.postgresql", "NAME": "folio_schema_reference"}, alias="schema_reference")
    connections["schema_reference"] = wrapper
    wrapper.pg_version = 170000
    # Render migration defaults offline. Psycopg's default composer would open
    # a database cursor even though this editor only collects reference SQL.
    def compose_offline(sql, params):
        if params:
            from psycopg.sql import Literal
            return sql % tuple(Literal(value).as_string(None) for value in params)
        return sql
    wrapper.ops.compose_sql = compose_offline
    with wrapper.schema_editor(collect_sql=True, atomic=False) as editor:
        for migration in migrations:
            state = migration.apply(state, editor, collect_sql=True)
    header = [
        "-- Folio: esquema PostgreSQL generado de las migraciones de core.",
        "-- REFERENCIA. Instalación soportada: python backend/manage.py migrate.",
        "-- No ejecutar este archivo antes o después de migrate en la misma base.",
        "-- Las tablas auth_group y auth_permission son dependencias de Django.",
        "-- Las migraciones crean esas dependencias y registran su aplicación.",
        "-- Datos de ejemplo: ejecutar seed.sql después de migrate.",
        "",
    ]
    (DESTINATION / "schema.sql").write_text("\n".join(header + editor.collected_sql) + "\n", encoding="utf-8")


if __name__ == "__main__":
    generate_seed()
    if "--seed-only" not in sys.argv:
        generate_schema()
    print("SQL generado en database/.")
