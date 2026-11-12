import json
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID, uuid4

from django.conf import settings
from django.contrib.sessions.models import Session
from django.core.cache import cache
from django.test import SimpleTestCase, TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from .emails import EmailDeliveryError, send_login_verification_code
from .models import LoginChallenge, User


PASSWORD = "OriginalExample492!"
LOGIN_URL = "/api/auth/login/"


@override_settings(
    PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],
    RESEND_API_KEY="re_login_tests_only",
    RESEND_FROM_EMAIL="Folio <security@example.com>",
    RESEND_REPLY_TO_EMAIL="",
)
class LoginVerificationTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="login_owner", email="owner@example.com", nombre="Persona de prueba", password=PASSWORD, notifications=False)
        self.client = APIClient()
        self.sender = patch("core.login_verification.send_login_verification_code").start()
        self.addCleanup(patch.stopall)

    def login(self, client=None, identifier=None, password=PASSWORD):
        return (client or self.client).post(LOGIN_URL, {"identifier": identifier or self.user.username, "password": password}, format="json")

    def begin(self, client=None):
        response = self.login(client)
        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue(response.data["verification_required"])
        code = self.sender.call_args.args[1]
        self.assertRegex(code, r"^[0-9]{6}$")
        return {"challenge_id": response.data["challenge_id"], "code": code}

    def verify(self, challenge, client=None):
        return (client or self.client).post(LOGIN_URL + "verify/", challenge, format="json")

    def sign_in(self, client=None):
        challenge = self.begin(client)
        response = self.verify(challenge, client)
        self.assertEqual(response.status_code, 200, response.data)
        return response

    def allow_resend(self):
        LoginChallenge.objects.filter(user=self.user).update(sent_at=timezone.now() - timedelta(seconds=61))

    def test_correct_password_only_starts_verification_without_private_access(self):
        challenge = self.begin()
        response = self.login()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["challenge_id"], challenge["challenge_id"])
        self.assertNotIn("user", response.data)
        self.assertEqual(response.data["expires_in"], 600)
        UUID(response.data["challenge_id"])
        self.assertNotIn(self.user.email, response.data["email_hint"])
        self.assertNotIn("_auth_user_id", self.client.session)
        self.user.refresh_from_db()
        self.assertEqual(self.user.active_session_key, "")
        for path in ["auth/me", "dashboard", "portfolio", "transactions"]:
            self.assertEqual(self.client.get("/api/" + path + "/").status_code, 403)
        self.sender.assert_called_once()

    def test_wrong_password_missing_or_inactive_account_does_not_send_code(self):
        for identifier, password in [(self.user.username, "WrongPassword492!"), ("missing", PASSWORD)]:
            with self.subTest(identifier=identifier):
                self.assertEqual(self.login(identifier=identifier, password=password).status_code, 400)
        self.user.is_active = False
        self.user.save(update_fields=["is_active"])
        self.assertEqual(self.login().status_code, 400)
        self.sender.assert_not_called()
        self.assertFalse(LoginChallenge.objects.exists())

    def test_correct_code_creates_persistent_cookie_and_private_access(self):
        response = self.sign_in()
        self.assertEqual(response.data["user"]["id"], self.user.pk)
        self.assertNotIn("password", response.data["user"])
        self.assertNotIn("active_session_key", response.data["user"])
        cookie = response.cookies[settings.SESSION_COOKIE_NAME]
        self.assertTrue(cookie["httponly"])
        self.assertEqual(cookie["samesite"], "Lax")
        self.assertGreater(int(cookie["max-age"]), 86400)
        self.assertTrue(cookie["expires"])
        self.assertFalse(self.client.session.get_expire_at_browser_close())
        self.user.refresh_from_db()
        self.assertEqual(self.user.active_session_key, cookie.value)
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 200)
        # Security mail is mandatory even when general notifications are disabled.
        self.assertFalse(self.user.notifications)

    def test_browser_reopening_with_saved_cookie_resumes_without_another_code(self):
        self.sign_in()
        reopened = APIClient()
        reopened.cookies = self.client.cookies.copy()
        self.sender.reset_mock()
        for _ in range(2):
            response = reopened.get("/api/auth/me/")
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.cookies[settings.SESSION_COOKIE_NAME]["max-age"])
        self.sender.assert_not_called()

    def test_code_and_browser_nonce_are_not_stored_or_returned_as_plaintext(self):
        challenge = self.begin()
        row = LoginChallenge.objects.get(user=self.user)
        self.assertNotEqual(row.code_digest, challenge["code"])
        self.assertEqual(len(row.code_digest), 64)
        nonce = self.client.session["login_verification_nonce"]
        self.assertNotEqual(row.browser_digest, nonce)
        self.assertEqual(len(row.browser_digest), 64)
        response = self.login()
        self.assertNotIn("code", response.data)
        self.assertNotIn(nonce, json.dumps(response.data))
        self.assertNotIn(PASSWORD, json.dumps(response.data))

    def test_code_is_bound_to_requesting_browser_and_challenge(self):
        challenge = self.begin()
        stranger = APIClient()
        self.assertEqual(self.verify(challenge, stranger).status_code, 400)
        self.assertEqual(self.verify({**challenge, "challenge_id": str(uuid4())}).status_code, 400)
        self.assertEqual(stranger.get("/api/auth/me/").status_code, 403)
        self.assertEqual(self.verify(challenge).status_code, 200)

    def test_missing_and_malformed_code_cannot_create_session(self):
        challenge = self.begin()
        for code in ["", "123", "1234567", "abcdef", None]:
            with self.subTest(code=code):
                self.assertEqual(self.verify({**challenge, "code": code}).status_code, 400)
        self.assertEqual(self.verify({"challenge_id": challenge["challenge_id"]}).status_code, 400)
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 403)

    def test_five_wrong_guesses_lock_even_the_correct_code(self):
        challenge = self.begin()
        wrong = "000000" if challenge["code"] != "000000" else "111111"
        for _ in range(5):
            self.assertEqual(self.verify({**challenge, "code": wrong}).status_code, 400)
        self.assertEqual(self.verify(challenge).status_code, 400)
        row = LoginChallenge.objects.get(user=self.user)
        self.assertEqual(row.attempts, 5)
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 403)

    def test_expired_or_consumed_code_cannot_authenticate(self):
        challenge = self.begin()
        LoginChallenge.objects.filter(user=self.user).update(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.verify(challenge).status_code, 400)
        LoginChallenge.objects.filter(user=self.user).update(expires_at=timezone.now() + timedelta(minutes=1))
        self.assertEqual(self.verify(challenge).status_code, 200)
        self.assertEqual(self.verify(challenge).status_code, 400)
        self.assertIsNotNone(LoginChallenge.objects.get(user=self.user).consumed_at)

    def test_password_or_email_changes_invalidate_pending_code(self):
        challenge = self.begin()
        old_password = self.user.password
        self.user.set_password("UpdatedOutsideLogin837!")
        self.user.save(update_fields=["password"])
        self.assertEqual(self.verify(challenge).status_code, 400)
        self.user.password = old_password
        self.user.email = "changed@example.com"
        self.user.save(update_fields=["password", "email"])
        self.assertEqual(self.verify(challenge).status_code, 400)

    def test_deactivated_account_cannot_complete_pending_verification(self):
        challenge = self.begin()
        self.user.is_active = False
        self.user.save(update_fields=["is_active"])
        self.assertEqual(self.verify(challenge).status_code, 400)

    def test_resend_rotates_code_and_rejects_previous_challenge(self):
        original = self.begin()
        self.allow_resend()
        response = self.client.post(LOGIN_URL + "resend/", {"challenge_id": original["challenge_id"]}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        replacement = {"challenge_id": response.data["challenge_id"], "code": self.sender.call_args.args[1]}
        self.assertNotEqual(replacement["challenge_id"], original["challenge_id"])
        self.assertEqual(self.sender.call_count, 2)
        self.assertEqual(self.verify(original).status_code, 400)
        self.assertEqual(self.verify(replacement).status_code, 200)

    def test_resend_cooldown_and_browser_binding_preserve_current_challenge(self):
        original = self.begin()
        payload = {"challenge_id": original["challenge_id"]}
        self.assertEqual(self.client.post(LOGIN_URL + "resend/", payload, format="json").status_code, 429)
        self.allow_resend()
        stranger = APIClient()
        self.assertEqual(stranger.post(LOGIN_URL + "resend/", payload, format="json").status_code, 400)
        self.assertEqual(self.sender.call_count, 1)
        self.assertEqual(self.verify(original).status_code, 200)

    def test_account_send_budget_cannot_be_bypassed_from_different_ip(self):
        original = self.begin()
        self.allow_resend()
        LoginChallenge.objects.filter(user=self.user).update(send_count=5)
        other = APIClient(REMOTE_ADDR="192.0.2.9")
        self.assertEqual(self.login(other).status_code, 429)
        self.assertEqual(self.sender.call_count, 1)
        self.assertEqual(self.verify(original).status_code, 200)

    def test_new_device_request_keeps_active_session_until_new_device_verifies(self):
        self.sign_in()
        old_key = self.client.cookies[settings.SESSION_COOKIE_NAME].value
        self.allow_resend()
        another_device = APIClient()
        challenge = self.begin(another_device)
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 200)
        self.assertEqual(another_device.get("/api/auth/me/").status_code, 403)
        self.assertEqual(self.verify(challenge, another_device).status_code, 200)
        self.assertFalse(Session.objects.filter(session_key=old_key).exists())
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 403)
        self.assertEqual(another_device.get("/api/auth/me/").status_code, 200)
        self.user.refresh_from_db()
        self.assertEqual(self.user.active_session_key, another_device.cookies[settings.SESSION_COOKIE_NAME].value)

    def test_failed_verification_on_another_device_does_not_revoke_current_session(self):
        self.sign_in()
        self.allow_resend()
        another_device = APIClient()
        challenge = self.begin(another_device)
        wrong = "000000" if challenge["code"] != "000000" else "111111"
        for _ in range(5):
            self.assertEqual(self.verify({**challenge, "code": wrong}, another_device).status_code, 400)
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 200)

    def test_logout_revokes_cookie_and_requires_a_new_email_verification(self):
        self.sign_in()
        old_cookie = self.client.cookies.copy()
        self.assertEqual(self.client.post("/api/auth/logout/", {}, format="json").status_code, 200)
        self.user.refresh_from_db()
        self.assertEqual(self.user.active_session_key, "")
        replay = APIClient()
        replay.cookies = old_cookie
        self.assertEqual(replay.get("/api/auth/me/").status_code, 403)
        self.allow_resend()
        self.assertTrue(self.login().data["verification_required"])
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 403)

    def test_stale_device_logout_cannot_revoke_newer_device(self):
        self.sign_in()
        self.allow_resend()
        another_device = APIClient()
        self.sign_in(another_device)
        self.assertEqual(self.client.post("/api/auth/logout/", {}, format="json").status_code, 403)
        self.assertEqual(another_device.get("/api/auth/me/").status_code, 200)

    def test_plain_django_session_cannot_bypass_email_verification(self):
        self.client.force_login(self.user)
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 403)
        self.assertEqual(self.client.get("/api/dashboard/").status_code, 403)

    def test_registration_also_requires_verification_before_private_access(self):
        payload = {"username": "registered", "email": "registered@example.com", "nombre": "Nueva persona", "password": "SecureVault637!"}
        response = self.client.post("/api/auth/register/", payload, format="json")
        self.assertEqual(response.status_code, 201, response.data)
        self.assertTrue(response.data["verification_required"])
        self.assertNotIn("user", response.data)
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 403)
        code = self.sender.call_args.args[1]
        verified = self.verify({"challenge_id": response.data["challenge_id"], "code": code})
        self.assertEqual(verified.status_code, 200)
        self.assertEqual(verified.data["user"]["username"], "registered")
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 200)

    def test_mail_failure_does_not_authenticate_or_replace_existing_session(self):
        self.sign_in()
        self.allow_resend()
        self.sender.side_effect = EmailDeliveryError("Private provider details")
        another_device = APIClient()
        response = self.login(another_device)
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("Private provider details", json.dumps(response.data))
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 200)
        self.assertEqual(another_device.get("/api/auth/me/").status_code, 403)

    def test_failed_resend_preserves_previous_code_and_send_budget(self):
        original = self.begin()
        self.allow_resend()
        row = LoginChallenge.objects.get(user=self.user)
        self.sender.side_effect = EmailDeliveryError("Provider unavailable")
        response = self.client.post(LOGIN_URL + "resend/", {"challenge_id": original["challenge_id"]}, format="json")
        self.assertEqual(response.status_code, 503)
        row.refresh_from_db()
        self.assertEqual(str(row.challenge_id), original["challenge_id"])
        self.assertEqual(row.send_count, 1)
        self.assertEqual(self.verify(original).status_code, 200)

    def test_ip_limits_apply_to_verification_and_resend_across_session_states(self):
        self.sign_in()
        with patch("core.login_verification.LoginVerificationThrottle.THROTTLE_RATES", {"login_verify": "2/minute", "login_resend": "2/minute"}):
            for action in ["verify", "resend"]:
                with self.subTest(action=action):
                    cache.clear()
                    self.assertEqual(self.client.post(LOGIN_URL + action + "/", {}, format="json").status_code, 400)
                    anonymous = APIClient()
                    self.assertEqual(anonymous.post(LOGIN_URL + action + "/", {}, format="json").status_code, 400)
                    response = self.client.post(LOGIN_URL + action + "/", {}, format="json")
                    self.assertEqual(response.status_code, 429)
                    self.assertIn("Retry-After", response)
                    separate_ip = APIClient(REMOTE_ADDR="192.0.2.10")
                    self.assertEqual(separate_ip.post(LOGIN_URL + action + "/", {}, format="json").status_code, 400)

    def test_failed_registration_email_rolls_back_account_creation(self):
        self.sender.side_effect = EmailDeliveryError("Private provider details")
        response = self.client.post("/api/auth/register/", {"username": "undelivered", "email": "undelivered@example.com", "nombre": "Persona", "password": "SecureVault637!"}, format="json")
        self.assertEqual(response.status_code, 503)
        self.assertFalse(User.objects.filter(username="undelivered").exists())
        self.assertFalse(LoginChallenge.objects.exists())

    @override_settings(RESEND_API_KEY="")
    def test_unconfigured_email_returns_error_and_does_not_authenticate(self):
        self.assertEqual(self.login().status_code, 503)
        self.sender.assert_not_called()
        self.assertFalse(LoginChallenge.objects.exists())
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 403)

    def test_all_public_login_steps_require_csrf_and_verification_rotates_token(self):
        client = APIClient(enforce_csrf_checks=True)
        for url in [LOGIN_URL, LOGIN_URL + "verify/", LOGIN_URL + "resend/", "/api/auth/register/"]:
            self.assertEqual(client.post(url, {}, format="json").status_code, 403)
        client.get("/api/auth/csrf/")
        token = client.cookies["csrftoken"].value
        pending = client.post(LOGIN_URL, {"identifier": self.user.username, "password": PASSWORD}, format="json", HTTP_X_CSRFTOKEN=token)
        self.assertEqual(pending.status_code, 200)
        code = self.sender.call_args.args[1]
        verified = client.post(LOGIN_URL + "verify/", {"challenge_id": pending.data["challenge_id"], "code": code}, format="json", HTTP_X_CSRFTOKEN=token)
        self.assertEqual(verified.status_code, 200)
        self.assertNotEqual(client.cookies["csrftoken"].value, token)
        self.assertEqual(client.post("/api/auth/logout/", {}, format="json").status_code, 403)


@override_settings(RESEND_API_KEY="re_login_transport_test", RESEND_FROM_EMAIL="Folio <security@example.com>", RESEND_REPLY_TO_EMAIL="", RESEND_TIMEOUT_SECONDS=10)
class LoginEmailTests(SimpleTestCase):
    def test_login_mail_uses_existing_secure_transport_without_password(self):
        user = SimpleNamespace(email="owner@example.com", nombre="<script>not HTML</script>", username="owner")
        challenge_id = uuid4()
        with patch("core.emails.urlopen") as transport:
            response = transport.return_value.__enter__.return_value
            response.status = 200
            response.read.return_value = b'{"id":"login-email-id"}'
            self.assertEqual(send_login_verification_code(user, "003714", challenge_id=challenge_id), "login-email-id")
            request = transport.call_args.args[0]
            self.assertEqual(request.full_url, "https://api.resend.com/emails")
            self.assertEqual(request.get_header("Authorization"), "Bearer re_login_transport_test")
            self.assertIn(str(challenge_id), request.get_header("Idempotency-key"))
            self.assertNotIn("password-reset", request.get_header("Idempotency-key"))
            payload = json.loads(request.data)
            self.assertEqual(payload["to"], [user.email])
            self.assertIn("003714", payload["text"])
            self.assertIn("003714", payload["html"])
            self.assertNotIn("<script>", payload["html"])
            self.assertIn("&lt;script&gt;", payload["html"])
            self.assertNotIn(PASSWORD, json.dumps(payload))
