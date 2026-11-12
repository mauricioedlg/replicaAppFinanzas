from django.contrib.auth import authenticate
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.http import JsonResponse
from django.utils.dateparse import parse_date
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from rest_framework import status
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle
from rest_framework.views import APIView

from .models import Stock, Transaction
from .emails import EmailDeliveryError
from .login_verification import DELIVERY_ERROR_DETAIL, LoginVerificationRateLimit, begin_login_verification, rate_limit_response
from .session_authentication import revoke_verified_session
from .serializers import LoginSerializer, RegistrationSerializer, StockSerializer, TradeSerializer, TransactionSerializer, UserSerializer
from .services import execute_trade, investment_chart, portfolio_for
from .payment_views import TopUpCreateView


@ensure_csrf_cookie
def csrf_token(request):
    return JsonResponse({"detail": "Token CSRF disponible."})


def health(request):
    return JsonResponse({"status": "ok"})


def csrf_failure(request, reason=""):
    return JsonResponse({"detail": "La sesión de seguridad expiró. Actualiza la página e inténtalo de nuevo."}, status=403)


class LoginThrottle(SimpleRateThrottle):
    scope = "login"

    def get_cache_key(self, request, view):
        # Existing sessions must not bypass the limit on password attempts.
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}


@method_decorator(csrf_protect, name="dispatch")
class LoginView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [LoginThrottle]

    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = authenticate(request, username=serializer.validated_data["identifier"], password=serializer.validated_data["password"])
        if not user:
            return Response({"detail": "El usuario o la contraseña son incorrectos."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            result = begin_login_verification(request, user)
        except LoginVerificationRateLimit as exc:
            return rate_limit_response(exc)
        except EmailDeliveryError:
            return Response({"detail": DELIVERY_ERROR_DETAIL}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        return Response(result)


@method_decorator(csrf_protect, name="dispatch")
class RegisterView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [LoginThrottle]

    def post(self, request):
        serializer = RegistrationSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            with transaction.atomic():
                user = serializer.save()
                result = begin_login_verification(request, user)
        except IntegrityError:
            raise ValidationError({"detail": "El usuario o correo ya está registrado."})
        except LoginVerificationRateLimit as exc:
            return rate_limit_response(exc)
        except EmailDeliveryError:
            return Response({"detail": DELIVERY_ERROR_DETAIL}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        return Response(result, status=status.HTTP_201_CREATED)


class LogoutView(APIView):
    def post(self, request):
        revoke_verified_session(request)
        return Response({"detail": "Sesión cerrada."})


class MeView(APIView):
    def get(self, request):
        return Response({"user": UserSerializer(request.user).data})

    def patch(self, request):
        serializer = UserSerializer(request.user, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        try:
            with transaction.atomic():
                serializer.save()
        except IntegrityError:
            raise ValidationError({"email": ["Este correo ya está registrado."]})
        return Response({"user": serializer.data})


class StockListView(APIView):
    def get(self, request):
        stocks = Stock.objects.all()
        search = request.query_params.get("search", "").strip()
        if search:
            stocks = stocks.filter(Q(symbol__icontains=search) | Q(nombre__icontains=search) | Q(sector__icontains=search))
        return Response(StockSerializer(stocks, many=True).data)


class PortfolioView(APIView):
    def get(self, request):
        return Response(portfolio_for(request.user))


class DashboardView(APIView):
    def get(self, request):
        return Response({
            "user": UserSerializer(request.user).data,
            **portfolio_for(request.user),
            "recent_transactions": TransactionSerializer(request.user.transactions.select_related("accion")[:5], many=True).data,
            "chart": investment_chart(request.user),
            "market": StockSerializer(Stock.objects.all(), many=True).data,
        })


class TransactionListView(APIView):
    def get(self, request):
        rows = request.user.transactions.select_related("accion")
        kind = request.query_params.get("type", "")
        if kind:
            if kind not in Transaction.Type.values:
                raise ValidationError({"type": ["Tipo de movimiento inválido."]})
            rows = rows.filter(tipo=kind)
        search = request.query_params.get("search", "").strip()
        if search:
            rows = rows.filter(Q(descripcion__icontains=search) | Q(accion__symbol__icontains=search))
        parsed = {}
        for name, lookup in [("start", "fecha__date__gte"), ("end", "fecha__date__lte")]:
            raw = request.query_params.get(name, "")
            if raw:
                try:
                    date = parse_date(raw)
                except ValueError:
                    date = None
                if date is None:
                    raise ValidationError({name: ["Usa una fecha válida con formato AAAA-MM-DD."]})
                parsed[name] = date
                rows = rows.filter(**{lookup: date})
        if "start" in parsed and "end" in parsed and parsed["start"] > parsed["end"]:
            raise ValidationError({"start": ["La fecha inicial debe ser anterior o igual a la final."]})
        return Response(TransactionSerializer(rows, many=True).data)


class TradeView(APIView):
    def post(self, request):
        serializer = TradeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        account, record = execute_trade(request.user, **serializer.validated_data)
        return Response({"detail": "Operación de simulación registrada.", "transaction": TransactionSerializer(record).data, "cash_balance": str(account.cash_balance)}, status=status.HTTP_201_CREATED)


class FundsView(TopUpCreateView):
    """Start a Stripe test payment; the signed webhook credits the balance."""
