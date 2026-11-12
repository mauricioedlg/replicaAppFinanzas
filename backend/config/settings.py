import os
from pathlib import Path

import dj_database_url
from django.core.exceptions import ImproperlyConfigured
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BASE_DIR.parent
load_dotenv(PROJECT_DIR / ".env", encoding="utf-8-sig")
load_dotenv(BASE_DIR / ".env", encoding="utf-8-sig")


def env_bool(name, default=False):
    return os.environ.get(name, str(default)).lower() in {"true", "1", "yes"}


DEBUG = env_bool("DJANGO_DEBUG", env_bool("DEBUG", True))
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "local-development-only-change-before-deployment")
if not DEBUG and SECRET_KEY == "local-development-only-change-before-deployment":
    raise ImproperlyConfigured("DJANGO_SECRET_KEY is required when DJANGO_DEBUG=false.")
ALLOWED_HOSTS = [item.strip() for item in os.environ.get("ALLOWED_HOSTS", "localhost,127.0.0.1,testserver").split(",") if item.strip()]
INSTALLED_APPS = [
    "django.contrib.admin", "django.contrib.auth", "django.contrib.contenttypes",
    "django.contrib.sessions", "django.contrib.messages", "django.contrib.staticfiles",
    "corsheaders", "rest_framework", "core",
]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware", "whitenoise.middleware.WhiteNoiseMiddleware",
    "corsheaders.middleware.CorsMiddleware", "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware", "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware", "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
ROOT_URLCONF = "config.urls"
TEMPLATES = [{"BACKEND": "django.template.backends.django.DjangoTemplates", "DIRS": [PROJECT_DIR / "frontend" / "dist"], "APP_DIRS": True,
              "OPTIONS": {"context_processors": ["django.template.context_processors.request", "django.contrib.auth.context_processors.auth", "django.contrib.messages.context_processors.messages"]}}]
WSGI_APPLICATION = "config.wsgi.application"

database_url = os.environ.get("DATABASE_URL", "").strip()
if env_bool("USE_SQLITE"):
    DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": BASE_DIR / "db.sqlite3", "OPTIONS": {"timeout": 20}}}
elif database_url:
    DATABASES = {"default": dj_database_url.parse(database_url, conn_max_age=0, conn_health_checks=True)}
    if DATABASES["default"]["ENGINE"] != "django.db.backends.postgresql":
        raise ImproperlyConfigured("DATABASE_URL must use PostgreSQL. Use USE_SQLITE=true only for local tests.")
    if ".neon.tech" in DATABASES["default"].get("HOST", ""):
        DATABASES["default"].setdefault("OPTIONS", {}).setdefault("sslmode", "require")
    DATABASES["default"]["DISABLE_SERVER_SIDE_CURSORS"] = True
else:
    raise ImproperlyConfigured(
        f"DATABASE_URL is missing. Create {PROJECT_DIR / '.env'} using .env.example "
        "and set your Neon PostgreSQL connection string there; .env.example is only a template. "
        "Use USE_SQLITE=true only for local development."
    )

AUTH_USER_MODEL = "core.User"
AUTHENTICATION_BACKENDS = ["core.authentication.IdentifierBackend"]
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 8}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["core.session_authentication.SingleDeviceSessionAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_THROTTLE_CLASSES": ["rest_framework.throttling.AnonRateThrottle", "rest_framework.throttling.UserRateThrottle"],
    "DEFAULT_THROTTLE_RATES": {
        "anon": "60/minute", "user": "600/minute", "login": "10/minute",
        "password_reset_request": "10/hour", "password_reset_verify": "30/minute", "password_reset_confirm": "10/minute",
        "login_verify": "30/minute", "login_resend": "10/hour",
    },
    "COERCE_DECIMAL_TO_STRING": True,
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
}
# Server-only transactional mail. Empty credentials leave the rest of the app usable.
RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "").strip()
RESEND_FROM_EMAIL = os.environ.get("RESEND_FROM_EMAIL", "").strip()
RESEND_REPLY_TO_EMAIL = os.environ.get("RESEND_REPLY_TO_EMAIL", "").strip()
RESEND_TIMEOUT_SECONDS = os.environ.get("RESEND_TIMEOUT_SECONDS", "10")
# Only sandbox card payments fund the simulated portfolio. All keys live in
# the root .env; the authenticated config endpoint exposes only the public key.
STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY", "").strip()
STRIPE_PUBLISHABLE_KEY = os.environ.get("STRIPE_PUBLISHABLE_KEY", "").strip()
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "").strip()
STRIPE_TIMEOUT_SECONDS = 10
STRIPE_MIN_TOPUP = "10.00"
STRIPE_MAX_TOPUP = "999999.99"
LANGUAGE_CODE = "es-mx"
TIME_ZONE = "America/Mexico_City"
USE_I18N = True
USE_TZ = True
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STATICFILES_DIRS = [PROJECT_DIR / "frontend" / "dist"] if (PROJECT_DIR / "frontend" / "dist").is_dir() else []
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
CSRF_TRUSTED_ORIGINS = [item.strip() for item in os.environ.get("CSRF_TRUSTED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,http://localhost:8000,http://127.0.0.1:8000").split(",") if item.strip()]
CORS_ALLOWED_ORIGINS = [item.strip() for item in os.environ.get("CORS_ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if item.strip()]
CORS_ALLOW_CREDENTIALS = True
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
try:
    LOGIN_SESSION_DAYS = int(os.environ.get("LOGIN_SESSION_DAYS", "365"))
except ValueError as exc:
    raise ImproperlyConfigured("LOGIN_SESSION_DAYS must be a positive integer (at most 400 days).") from exc
if not 1 <= LOGIN_SESSION_DAYS <= 400:
    raise ImproperlyConfigured("LOGIN_SESSION_DAYS must be a positive integer (at most 400 days).")
SESSION_COOKIE_AGE = LOGIN_SESSION_DAYS * 24 * 60 * 60
SESSION_EXPIRE_AT_BROWSER_CLOSE = False
SESSION_SAVE_EVERY_REQUEST = True
CSRF_COOKIE_SAMESITE = "Lax"
CSRF_FAILURE_VIEW = "core.views.csrf_failure"
SESSION_COOKIE_SECURE = env_bool("SESSION_COOKIE_SECURE", not DEBUG)
CSRF_COOKIE_SECURE = env_bool("CSRF_COOKIE_SECURE", not DEBUG)
SECURE_SSL_REDIRECT = env_bool("SECURE_SSL_REDIRECT", not DEBUG)
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = "DENY"
SECURE_HSTS_SECONDS = 31536000 if not DEBUG else 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = not DEBUG
SECURE_HSTS_PRELOAD = not DEBUG
