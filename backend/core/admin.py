from django.contrib import admin
from django.contrib.auth.admin import UserAdmin

from .models import Holding, Stock, Transaction, User


@admin.register(User)
class FinanceUserAdmin(UserAdmin):
    fieldsets = UserAdmin.fieldsets + (("Perfil de inversión", {"fields": ("nombre", "telefono", "cash_balance", "notifications", "dark_mode")}),)
    list_display = ("username", "email", "nombre", "cash_balance", "is_staff")


admin.site.register(Stock)
admin.site.register(Holding)
admin.site.register(Transaction)
