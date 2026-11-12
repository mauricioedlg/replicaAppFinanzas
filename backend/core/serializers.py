import re
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers

from .models import Stock, Transaction

User = get_user_model()


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ["id", "username", "email", "nombre", "telefono", "cash_balance", "notifications", "dark_mode"]
        read_only_fields = ["id", "username", "cash_balance"]

    def update(self, instance, validated_data):
        # A profile request may hold an instance loaded before a trade commits.
        # Write only profile fields so it cannot restore a stale account balance.
        for name, value in validated_data.items():
            setattr(instance, name, value)
        if validated_data:
            instance.save(update_fields=list(validated_data))
        instance.refresh_from_db()
        return instance

    def validate_email(self, value):
        email = value.strip().lower()
        query = User.objects.filter(email__iexact=email)
        if self.instance:
            query = query.exclude(pk=self.instance.pk)
        if query.exists():
            raise serializers.ValidationError("Este correo ya está registrado.")
        return email

    def validate_nombre(self, value):
        if not value.strip():
            raise serializers.ValidationError("Escribe tu nombre.")
        return value.strip()

    def validate_telefono(self, value):
        if value and not re.fullmatch(r"[+()\d\s-]{7,30}", value):
            raise serializers.ValidationError("Escribe un teléfono válido de 7 a 30 caracteres.")
        return value.strip()


class RegistrationSerializer(UserSerializer):
    username = serializers.RegexField(r"^[A-Za-z0-9_.-]+$", max_length=150, min_length=3)
    password = serializers.CharField(write_only=True, max_length=128, trim_whitespace=False)

    class Meta(UserSerializer.Meta):
        fields = ["id", "username", "email", "nombre", "telefono", "password"]
        read_only_fields = ["id"]

    def validate_username(self, value):
        if User.objects.filter(username__iexact=value).exists():
            raise serializers.ValidationError("Este nombre de usuario ya está registrado.")
        return value

    def validate(self, attrs):
        candidate = User(username=attrs.get("username"), email=attrs.get("email"), nombre=attrs.get("nombre"))
        try:
            validate_password(attrs["password"], candidate)
        except DjangoValidationError as exc:
            raise serializers.ValidationError({"password": list(exc.messages)})
        return attrs

    def create(self, validated_data):
        return User.objects.create_user(**validated_data)


class LoginSerializer(serializers.Serializer):
    identifier = serializers.CharField(max_length=254)
    password = serializers.CharField(max_length=128, trim_whitespace=False, write_only=True)


class StockSerializer(serializers.ModelSerializer):
    class Meta:
        model = Stock
        fields = ["id", "symbol", "nombre", "sector", "precio", "cambio_porcentual", "color"]


class TransactionSerializer(serializers.ModelSerializer):
    symbol = serializers.CharField(source="accion.symbol", default=None, read_only=True)
    stock_name = serializers.CharField(source="accion.nombre", default=None, read_only=True)

    class Meta:
        model = Transaction
        fields = ["id", "tipo", "descripcion", "symbol", "stock_name", "cantidad", "precio_unitario", "monto", "fecha"]


class TradeSerializer(serializers.Serializer):
    stock_id = serializers.IntegerField(min_value=1)
    side = serializers.ChoiceField(choices=["buy", "sell"])
    quantity = serializers.DecimalField(max_digits=18, decimal_places=6, min_value=Decimal("0.000001"))
