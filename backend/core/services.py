from decimal import Decimal, ROUND_HALF_UP, localcontext

from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import NotFound, ValidationError

from .models import Holding, Stock, Transaction, User
from .serializers import StockSerializer

ZERO = Decimal("0")
CENT = Decimal("0.01")
MAX_MONEY = Decimal("9999999999999999.99")


def money(value):
    with localcontext() as context:
        context.prec = 48
        return Decimal(value).quantize(CENT, rounding=ROUND_HALF_UP)


def amount_text(value):
    return str(money(value))


def portfolio_for(user):
    holdings = list(Holding.objects.filter(usuario=user).select_related("accion"))
    total_value = sum((money(item.quantity * item.accion.precio) for item in holdings), ZERO)
    total_cost = sum((item.invested for item in holdings), ZERO)
    result = []
    for item in holdings:
        current_value = money(item.quantity * item.accion.precio)
        profit = current_value - item.invested
        result.append({
            "id": item.pk, "stock": StockSerializer(item.accion).data,
            "quantity": str(item.quantity), "invested": amount_text(item.invested),
            "current_value": amount_text(current_value), "profit": amount_text(profit),
            "profit_percent": amount_text(profit / item.invested * 100 if item.invested else ZERO),
            "allocation": amount_text(current_value / total_value * 100 if total_value else ZERO),
        })
    cash_balance = Decimal(user.cash_balance)
    return {
        "summary": {
            "portfolio_value": amount_text(total_value), "invested": amount_text(total_cost),
            "profit": amount_text(total_value - total_cost),
            "profit_percent": amount_text((total_value - total_cost) / total_cost * 100 if total_cost else ZERO),
            "cash_balance": amount_text(cash_balance), "total_equity": amount_text(total_value + cash_balance),
            "assets_count": len(holdings),
        },
        "holdings": result,
    }


def investment_chart(user):
    """Cumulative purchase amounts minus sale proceeds; never market history."""
    rows = Transaction.objects.filter(usuario=user, tipo__in=["buy", "sell"]).order_by("fecha", "id")
    net = ZERO
    by_day = {}
    for row in rows:
        day = timezone.localtime(row.fecha).date().isoformat()
        net += row.monto if row.tipo == "buy" else -row.monto
        by_day[day] = amount_text(net)
    today = timezone.localdate().isoformat()
    by_day[today] = amount_text(net)
    return [{"date": day, "value": value} for day, value in by_day.items()]


@transaction.atomic
def execute_trade(user, stock_id, side, quantity):
    # Every account mutation takes the same user-row lock first. Concurrent
    # purchases/deposits cannot spend or overwrite the same balance twice.
    account = User.objects.select_for_update().get(pk=user.pk)
    try:
        stock = Stock.objects.select_for_update().get(pk=stock_id)
    except Stock.DoesNotExist:
        raise NotFound("La acción no existe.")
    amount = money(quantity * stock.precio)
    if amount <= 0 or amount > MAX_MONEY:
        raise ValidationError({"quantity": ["El importe debe ser al menos $0.01 y estar dentro del límite permitido."]})
    holding = Holding.objects.select_for_update().filter(usuario=account, accion=stock).first()

    if side == "buy":
        if amount > account.cash_balance:
            raise ValidationError({"detail": "No tienes saldo disponible suficiente para esta compra."})
        new_quantity = (holding.quantity if holding else ZERO) + quantity
        new_invested = (holding.invested if holding else ZERO) + amount
        if new_quantity >= Decimal("1000000000000") or new_invested > MAX_MONEY:
            raise ValidationError({"quantity": ["La posición supera el límite permitido."]})
        if holding:
            holding.quantity = new_quantity
            holding.invested = new_invested
            holding.save(update_fields=["quantity", "invested"])
        else:
            Holding.objects.create(usuario=account, accion=stock, quantity=quantity, invested=amount)
        account.cash_balance -= amount
        verb = "Compra"
    else:
        if not holding or quantity > holding.quantity:
            raise ValidationError({"detail": "No tienes suficientes títulos para esta venta."})
        if account.cash_balance + amount > MAX_MONEY:
            raise ValidationError({"detail": "La venta supera el límite de saldo permitido."})
        if quantity == holding.quantity:
            holding.delete()
        else:
            cost_sold = money(holding.invested * quantity / holding.quantity)
            holding.quantity -= quantity
            holding.invested -= cost_sold
            holding.save(update_fields=["quantity", "invested"])
        account.cash_balance += amount
        verb = "Venta"

    account.save(update_fields=["cash_balance"])
    record = Transaction.objects.create(
        usuario=account, accion=stock, tipo=side,
        descripcion=f"{verb} de {quantity.normalize():f} títulos de {stock.nombre}",
        cantidad=quantity, precio_unitario=stock.precio, monto=amount, fecha=timezone.now(),
    )
    return account, record


@transaction.atomic
def deposit_funds(user, amount):
    account = User.objects.select_for_update().get(pk=user.pk)
    if account.cash_balance + amount > MAX_MONEY:
        raise ValidationError({"amount": ["El depósito supera el límite de saldo permitido."]})
    account.cash_balance += amount
    account.save(update_fields=["cash_balance"])
    record = Transaction.objects.create(usuario=account, tipo="deposit", descripcion="Depósito de saldo de simulación", monto=amount, fecha=timezone.now())
    return account, record
