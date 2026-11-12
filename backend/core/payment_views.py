"""Authenticated card/top-up endpoints and a signature-authenticated webhook."""
import logging

import stripe
from django.conf import settings
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST
from rest_framework import serializers, status
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from .emails import EmailDeliveryError
from .models import PaymentCard, TopUp, User
from .payments import (
    CardVerificationRateLimit, PaymentsUnavailable, card_data, confirm_card_verification,
    create_card_setup, create_topup, disable_card, ensure_payments_configured,
    payment_config, process_payment_event, request_card_verification, topup_data,
)

logger = logging.getLogger(__name__)


class CardSetupSerializer(serializers.Serializer):
    request_id = serializers.UUIDField()


class CardCodeSerializer(serializers.Serializer):
    challenge_id = serializers.UUIDField()
    code = serializers.RegexField(r"^[0-9]{6}$", min_length=6, max_length=6, trim_whitespace=False, write_only=True)


class TopUpSerializer(CardSetupSerializer):
    card_id = serializers.UUIDField()
    amount = serializers.DecimalField(max_digits=18, decimal_places=2, min_value=0)


class PaymentAPIView(APIView):
    def handle_exception(self, exc):
        response = super().handle_exception(exc)
        if isinstance(exc, CardVerificationRateLimit):
            response["Retry-After"] = str(exc.retry_after)
        return response


class PaymentConfigView(PaymentAPIView):
    def get(self, request):
        return Response(payment_config())


class CardListView(PaymentAPIView):
    def get(self, request):
        cards = PaymentCard.objects.filter(usuario=request.user, disabled_at__isnull=True).select_related("usuario")
        return Response({"cards": [card_data(card) for card in cards]})


class CardSetupView(PaymentAPIView):
    def post(self, request):
        serializer = CardSetupSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(create_card_setup(request.user, serializer.validated_data["request_id"]), status=status.HTTP_201_CREATED)


class CardVerificationRequestView(PaymentAPIView):
    def post(self, request, card_id):
        try:
            return Response(request_card_verification(request.user, card_id))
        except EmailDeliveryError:
            return Response({"detail": "No pudimos enviar el código de la tarjeta. Inténtalo de nuevo más tarde."}, status=status.HTTP_503_SERVICE_UNAVAILABLE)


class CardVerificationConfirmView(PaymentAPIView):
    def post(self, request, card_id):
        serializer = CardCodeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(confirm_card_verification(request.user, card_id, **serializer.validated_data))


class CardDetailView(PaymentAPIView):
    def delete(self, request, card_id):
        disable_card(request.user, card_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class TopUpCreateView(PaymentAPIView):
    def post(self, request):
        serializer = TopUpSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(create_topup(request.user, **serializer.validated_data), status=status.HTTP_201_CREATED)


class TopUpDetailView(PaymentAPIView):
    def get(self, request, topup_id):
        topup = TopUp.objects.select_related("card__usuario").filter(pk=topup_id, usuario=request.user).first()
        if topup is None:
            raise NotFound("La recarga no existe.")
        account = User.objects.get(pk=request.user.pk)
        return Response({"topup": topup_data(topup), "cash_balance": str(account.cash_balance)})


@csrf_exempt
@require_POST
def stripe_webhook(request):
    try:
        ensure_payments_configured()
    except PaymentsUnavailable:
        return JsonResponse({"detail": "El servicio de pagos de prueba no está configurado."}, status=503)
    try:
        event = stripe.Webhook.construct_event(
            request.body, request.headers.get("Stripe-Signature", ""), settings.STRIPE_WEBHOOK_SECRET,
        )
    except (ValueError, TypeError, stripe.SignatureVerificationError):
        return JsonResponse({"detail": "La firma del evento no es válida."}, status=400)
    try:
        process_payment_event(event)
    except ValidationError:
        return JsonResponse({"detail": "El evento no coincide con una recarga válida."}, status=400)
    return JsonResponse({"received": True})
