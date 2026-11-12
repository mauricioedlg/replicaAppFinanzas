from django.conf import settings
from django.contrib import admin
from django.http import HttpResponse, HttpResponseNotFound
from django.urls import path, re_path
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.static import serve

from core import payment_views, views
from core.password_reset import PasswordResetConfirmView, PasswordResetRequestView, PasswordResetVerifyView
from core.login_verification import LoginResendView, LoginVerificationView


@ensure_csrf_cookie
def spa(request):
    index = settings.PROJECT_DIR / "frontend" / "dist" / "index.html"
    if not index.is_file():
        return HttpResponse("La API está disponible. Inicia el frontend con npm run dev o ejecuta npm run build en frontend/.", content_type="text/plain; charset=utf-8")
    return HttpResponse(index.read_text(encoding="utf-8"), content_type="text/html; charset=utf-8")


urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/health/", views.health),
    path("api/auth/csrf/", views.csrf_token),
    path("api/auth/login/", views.LoginView.as_view()),
    path("api/auth/login/verify/", LoginVerificationView.as_view()),
    path("api/auth/login/resend/", LoginResendView.as_view()),
    path("api/auth/register/", views.RegisterView.as_view()),
    path("api/auth/password-reset/request/", PasswordResetRequestView.as_view()),
    path("api/auth/password-reset/verify/", PasswordResetVerifyView.as_view()),
    path("api/auth/password-reset/confirm/", PasswordResetConfirmView.as_view()),
    path("api/auth/logout/", views.LogoutView.as_view()),
    path("api/auth/me/", views.MeView.as_view()),
    path("api/stocks/", views.StockListView.as_view()),
    path("api/dashboard/", views.DashboardView.as_view()),
    path("api/portfolio/", views.PortfolioView.as_view()),
    path("api/transactions/", views.TransactionListView.as_view()),
    path("api/trades/", views.TradeView.as_view()),
    path("api/funds/", views.FundsView.as_view()),
    path("api/funds/<uuid:topup_id>/", payment_views.TopUpDetailView.as_view()),
    path("api/payments/config/", payment_views.PaymentConfigView.as_view()),
    path("api/cards/", payment_views.CardListView.as_view()),
    path("api/cards/setup/", payment_views.CardSetupView.as_view()),
    path("api/cards/<uuid:card_id>/", payment_views.CardDetailView.as_view()),
    path("api/cards/<uuid:card_id>/verification/request/", payment_views.CardVerificationRequestView.as_view()),
    path("api/cards/<uuid:card_id>/verification/confirm/", payment_views.CardVerificationConfirmView.as_view()),
    path("api/stripe/webhook/", payment_views.stripe_webhook),
    re_path(r"^api/.*$", lambda request: HttpResponseNotFound('{"detail":"Ruta de API no encontrada."}', content_type="application/json")),
]
if settings.DEBUG and (settings.PROJECT_DIR / "frontend" / "dist").is_dir():
    urlpatterns += [re_path(r"^static/(?P<path>.*)$", serve, {"document_root": settings.PROJECT_DIR / "frontend" / "dist"})]
urlpatterns += [re_path(r"^.*$", spa)]
