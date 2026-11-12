import json
from datetime import timedelta
from http.client import IncompleteRead
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from uuid import UUID, uuid4

from django.contrib.sessions.models import Session
from django.core.cache import cache
from django.test import SimpleTestCase, TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from .emails import EmailConfigurationError, EmailDeliveryError, send_password_reset_code, send_password_reset_confirmation
from .models import LoginChallenge, PasswordResetChallenge, User


RESET_URL = "/api/auth/password-reset/"
OLD_PASSWORD = "OriginalExample492!"
NEW_PASSWORD = "RenewedExample753!"
FAST_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]


@override_settings(
    PASSWORD_HASHERS=FAST_HASHERS,
    RESEND_API_KEY="re_test_key_never_sent",
    RESEND_FROM_EMAIL="Folio <security@example.com>",
    RESEND_REPLY_TO_EMAIL="support@example.com",
)
class PasswordRecoveryTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(
            username="recovering", email="recovering@example.com",
            password=OLD_PASSWORD, nombre="Cuenta de prueba", notifications=False,
        )
        self.other = User.objects.create_user(
            username="another", email="another@example.com",
            password=OLD_PASSWORD, nombre="Otra cuenta",
        )
        self.client = APIClient()
        self.send_code = patch("core.password_reset.send_password_reset_code").start()
        self.send_confirmation = patch("core.password_reset.send_password_reset_confirmation").start()
        self.send_login_code = patch("core.login_verification.send_login_verification_code").start()
        self.addCleanup(patch.stopall)

    def post(self, action, payload, client=None):
        return (client or self.client).post(RESET_URL + action + "/", payload, format="json")

    def request_code(self, email=None):
        response = self.post("request", {"email": email or self.user.email})
        self.assertEqual(response.status_code, 200, response.data)
        return response.data

    def begin(self):
        request = self.request_code()
        self.assertTrue(self.send_code.called)
        code = self.send_code.call_args.args[1]
        self.assertRegex(code, r"^[0-9]{6}$")
        return {"email": self.user.email, "challenge_id": request["challenge_id"], "code": code}

    def verified(self):
        challenge = self.begin()
        response = self.post("verify", challenge)
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["expires_in"], 300)
        return {"email": challenge["email"], "challenge_id": challenge["challenge_id"], "reset_token": response.data["reset_token"]}

    def confirm(self, token, **changes):
        return self.post("confirm", {**token, "password": NEW_PASSWORD, "confirm_password": NEW_PASSWORD, **changes})

    def sign_in(self, client, password=OLD_PASSWORD):
        LoginChallenge.objects.filter(user=self.user).update(sent_at=timezone.now() - timedelta(seconds=61))
        pending = client.post("/api/auth/login/", {"identifier": self.user.email, "password": password}, format="json")
        self.assertEqual(pending.status_code, 200, pending.data)
        self.assertTrue(pending.data["verification_required"])
        code = self.send_login_code.call_args.args[1]
        response = client.post("/api/auth/login/verify/", {"challenge_id": pending.data["challenge_id"], "code": code}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(client.get("/api/auth/me/").status_code, 200)

    def test_entire_recovery_changes_password_and_sends_security_confirmation(self):
        token = self.verified()
        response = self.confirm(token)
        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue(response.data["confirmation_email_sent"])
        self.send_confirmation.assert_called_once()
        self.assertEqual(self.send_confirmation.call_args.args[0].pk, self.user.pk)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(NEW_PASSWORD))
        self.assertFalse(self.user.check_password(OLD_PASSWORD))
        self.assertNotEqual(self.user.password, NEW_PASSWORD)
        self.assertEqual(self.client.post("/api/auth/login/", {"identifier": self.user.email, "password": OLD_PASSWORD}, format="json").status_code, 400)
        self.sign_in(self.client, NEW_PASSWORD)
        # Security mail is required even when marketing/app notifications are off.
        self.assertFalse(self.user.notifications)

    def test_public_response_and_database_never_contain_plaintext_secrets(self):
        challenge = self.begin()
        row = PasswordResetChallenge.objects.get(user=self.user)
        self.assertNotEqual(row.code_digest, challenge["code"])
        self.assertNotIn(challenge["code"], row.code_digest)
        request_keys = set(self.request_code("missing@example.com"))
        self.assertEqual(request_keys, {"detail", "challenge_id", "expires_in", "retry_after"})
        response = self.post("verify", challenge)
        self.assertEqual(response.status_code, 200)
        row.refresh_from_db()
        self.assertNotEqual(row.reset_token_digest, response.data["reset_token"])
        self.assertNotIn(response.data["reset_token"], row.reset_token_digest)

    def test_unknown_inactive_and_unusable_accounts_have_same_public_response(self):
        active = self.request_code()
        self.send_code.reset_mock()
        self.other.is_active = False
        self.other.save(update_fields=["is_active"])
        unusable = User.objects.create_user(username="external", email="external@example.com", nombre="Sin contraseña")
        for email in ["missing@example.com", self.other.email, unusable.email]:
            with self.subTest(email=email):
                result = self.request_code(email)
                self.assertEqual(set(result), set(active))
                for key in ["detail", "expires_in", "retry_after"]:
                    self.assertEqual(result[key], active[key])
                UUID(str(result["challenge_id"]))
        self.send_code.assert_not_called()
        self.assertEqual(PasswordResetChallenge.objects.count(), 1)

    def test_email_is_normalized_without_requiring_authenticated_session(self):
        result = self.request_code("  RECOVERING@EXAMPLE.COM  ")
        self.assertEqual(result["expires_in"], 600)
        self.assertEqual(result["retry_after"], 60)
        self.send_code.assert_called_once()
        self.assertEqual(PasswordResetChallenge.objects.get().email, self.user.email)

    def test_invalid_email_does_not_dispatch_email(self):
        for email in ["", "not-an-email", "a" * 255 + "@example.com"]:
            with self.subTest(email=email):
                self.assertEqual(self.post("request", {"email": email}).status_code, 400)
        self.send_code.assert_not_called()

    def test_wrong_code_cannot_verify_and_attempt_limit_includes_correct_code(self):
        challenge = self.begin()
        wrong = "000000" if challenge["code"] != "000000" else "111111"
        for _ in range(5):
            self.assertEqual(self.post("verify", {**challenge, "code": wrong}).status_code, 400)
        self.assertEqual(self.post("verify", challenge).status_code, 400)
        row = PasswordResetChallenge.objects.get(user=self.user)
        self.assertEqual(row.attempts, 5)
        self.assertFalse(row.reset_token_digest)

    def test_expired_code_is_rejected(self):
        challenge = self.begin()
        PasswordResetChallenge.objects.filter(user=self.user).update(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.post("verify", challenge).status_code, 400)

    def test_verified_code_cannot_issue_another_token(self):
        challenge = self.begin()
        self.assertEqual(self.post("verify", challenge).status_code, 200)
        self.assertEqual(self.post("verify", challenge).status_code, 400)

    def test_code_is_bound_to_both_email_and_challenge(self):
        challenge = self.begin()
        self.assertEqual(self.post("verify", {**challenge, "email": self.other.email}).status_code, 400)
        self.assertEqual(self.post("verify", {**challenge, "challenge_id": str(uuid4())}).status_code, 400)
        self.assertEqual(self.post("verify", challenge).status_code, 200)

    def test_resend_during_cooldown_does_not_dispatch_or_invalidate_real_code(self):
        challenge = self.begin()
        result = self.request_code()
        self.assertEqual(self.send_code.call_count, 1)
        self.assertNotEqual(str(result["challenge_id"]), str(challenge["challenge_id"]))
        self.assertEqual(self.post("verify", challenge).status_code, 200)

    def test_resend_replaces_old_challenge_and_invalidates_old_verified_token(self):
        token = self.verified()
        PasswordResetChallenge.objects.filter(user=self.user).update(sent_at=timezone.now() - timedelta(seconds=61))
        replacement = self.begin()
        self.assertEqual(self.send_code.call_count, 2)
        self.assertNotEqual(str(token["challenge_id"]), str(replacement["challenge_id"]))
        self.assertEqual(self.confirm(token).status_code, 400)
        self.assertEqual(self.post("verify", replacement).status_code, 200)
        self.assertEqual(PasswordResetChallenge.objects.filter(user=self.user).count(), 1)

    def test_per_account_hourly_cap_applies_across_requester_ips(self):
        self.begin()
        PasswordResetChallenge.objects.filter(user=self.user).update(
            sent_at=timezone.now() - timedelta(seconds=61), send_count=5,
        )
        self.client = APIClient(REMOTE_ADDR="192.0.2.2")
        self.request_code()
        self.assertEqual(self.send_code.call_count, 1)
        PasswordResetChallenge.objects.filter(user=self.user).update(send_window_started_at=timezone.now() - timedelta(hours=1, seconds=1))
        self.request_code()
        self.assertEqual(self.send_code.call_count, 2)
        self.assertEqual(PasswordResetChallenge.objects.get(user=self.user).send_count, 1)

    def test_new_password_requires_verified_token_and_token_is_bound_to_account(self):
        challenge = self.begin()
        forged = {"email": challenge["email"], "challenge_id": challenge["challenge_id"], "reset_token": "fabricated-token"}
        self.assertEqual(self.confirm(forged).status_code, 400)
        verification = self.post("verify", challenge)
        token = {**forged, "reset_token": verification.data["reset_token"]}
        self.assertEqual(self.confirm({**token, "email": self.other.email}).status_code, 400)
        self.assertEqual(self.confirm({**token, "challenge_id": str(uuid4())}).status_code, 400)
        self.assertEqual(self.confirm({**token, "reset_token": "wrong-token"}).status_code, 400)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(OLD_PASSWORD))
        self.assertEqual(self.confirm(token).status_code, 200)

    def test_verified_token_expires(self):
        token = self.verified()
        PasswordResetChallenge.objects.filter(user=self.user).update(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.confirm(token).status_code, 400)
        self.send_confirmation.assert_not_called()

    def test_token_can_only_change_password_once(self):
        token = self.verified()
        self.assertEqual(self.confirm(token).status_code, 200)
        self.assertEqual(self.confirm(token).status_code, 400)
        self.send_confirmation.assert_called_once()
        self.assertIsNotNone(PasswordResetChallenge.objects.get(user=self.user).consumed_at)

    def test_weak_or_mismatched_password_preserves_token_for_correction(self):
        token = self.verified()
        for password in ["short", "12345678", "password"]:
            with self.subTest(password=password):
                self.assertEqual(self.confirm(token, password=password, confirm_password=password).status_code, 400)
        self.assertEqual(self.confirm(token, confirm_password="DifferentPassword492!").status_code, 400)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(OLD_PASSWORD))
        self.assertEqual(self.confirm(token).status_code, 200)

    def test_challenge_is_invalid_after_email_changes(self):
        challenge = self.begin()
        self.user.email = "updated@example.com"
        self.user.save(update_fields=["email"])
        self.assertEqual(self.post("verify", challenge).status_code, 400)

    def test_verified_token_is_invalid_after_password_changes_elsewhere(self):
        token = self.verified()
        self.user.set_password("UpdatedOutsideRecovery294!")
        self.user.save(update_fields=["password"])
        self.assertEqual(self.confirm(token).status_code, 400)
        self.send_confirmation.assert_not_called()

    def test_success_logs_out_requester_and_invalidates_other_existing_sessions(self):
        requester = APIClient()
        another_session = APIClient()
        self.sign_in(requester)
        self.user.refresh_from_db()
        previous_session_key = self.user.active_session_key
        self.assertTrue(Session.objects.filter(session_key=previous_session_key).exists())
        # Stored copies of the active cookie must all fail after password reset.
        another_session.cookies = requester.cookies.copy()
        for client in [requester, another_session]:
            self.assertEqual(client.get("/api/auth/me/").status_code, 200)
        token = self.verified()
        response = self.post("confirm", {**token, "password": NEW_PASSWORD, "confirm_password": NEW_PASSWORD}, requester)
        self.assertEqual(response.status_code, 200)
        self.user.refresh_from_db()
        self.assertEqual(self.user.active_session_key, "")
        self.assertFalse(Session.objects.filter(session_key=previous_session_key).exists())
        self.assertEqual(requester.get("/api/auth/me/").status_code, 403)
        self.assertEqual(another_session.get("/api/auth/me/").status_code, 403)
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 403)

    def test_all_public_recovery_posts_require_csrf(self):
        client = APIClient(enforce_csrf_checks=True)
        for action in ["request", "verify", "confirm"]:
            with self.subTest(action=action):
                self.assertEqual(self.post(action, {}, client).status_code, 403)
        client.get("/api/auth/csrf/")
        response = client.post(RESET_URL + "request/", {"email": self.user.email}, format="json", HTTP_X_CSRFTOKEN=client.cookies["csrftoken"].value)
        self.assertEqual(response.status_code, 200)

    def test_ip_limits_apply_to_each_step_and_authenticated_sessions_cannot_bypass(self):
        rates = {"password_reset_request": "2/minute", "password_reset_verify": "2/minute", "password_reset_confirm": "2/minute"}
        with patch("core.password_reset.PasswordResetRequestThrottle.THROTTLE_RATES", rates):
            for action in ["request", "verify", "confirm"]:
                with self.subTest(action=action):
                    cache.clear()
                    self.assertEqual(self.post(action, {}).status_code, 400)
                    self.sign_in(self.client)
                    self.assertEqual(self.post(action, {}).status_code, 400)
                    blocked = self.post(action, {})
                    self.assertEqual(blocked.status_code, 429)
                    self.assertIn("Retry-After", blocked)
                    different_ip = APIClient(REMOTE_ADDR="192.0.2.7")
                    self.assertEqual(self.post(action, {}, different_ip).status_code, 400)

    @override_settings(RESEND_API_KEY="")
    def test_missing_configuration_fails_before_account_lookup(self):
        for email in [self.user.email, "missing@example.com"]:
            with self.subTest(email=email):
                self.assertEqual(self.post("request", {"email": email}).status_code, 503)
        self.assertFalse(PasswordResetChallenge.objects.exists())
        self.send_code.assert_not_called()

    def test_code_delivery_failure_rolls_back_challenge(self):
        self.send_code.side_effect = EmailDeliveryError("Provider unavailable")
        self.assertEqual(self.post("request", {"email": self.user.email}).status_code, 503)
        self.assertFalse(PasswordResetChallenge.objects.exists())

    def test_confirmation_delivery_failure_keeps_new_password_and_reports_truthfully(self):
        token = self.verified()
        self.send_confirmation.side_effect = EmailDeliveryError("Provider unavailable")
        response = self.confirm(token)
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.data["confirmation_email_sent"])
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(NEW_PASSWORD))
        self.assertEqual(self.confirm(token).status_code, 400)


@override_settings(
    RESEND_API_KEY="re_mock_transport_key",
    RESEND_FROM_EMAIL="Folio <security@example.com>",
    RESEND_REPLY_TO_EMAIL="support@example.com",
    RESEND_TIMEOUT_SECONDS=10,
)
class ResendTransportTests(SimpleTestCase):
    def setUp(self):
        self.user = SimpleNamespace(email="owner@example.com", nombre='<img src=x onerror="bad()">', username="owner")
        self.challenge_id = uuid4()
        self.transport = patch("core.emails.urlopen").start()
        self.addCleanup(patch.stopall)
        self.response = self.transport.return_value.__enter__.return_value
        self.response.status = 200
        self.response.read.return_value = b'{"id":"mail-id"}'

    def send(self):
        return send_password_reset_code(self.user, "003714", challenge_id=self.challenge_id)

    def test_http_request_has_server_credentials_payload_and_timeout(self):
        self.assertEqual(self.send(), "mail-id")
        request = self.transport.call_args.args[0]
        self.assertEqual(request.full_url, "https://api.resend.com/emails")
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.get_header("Authorization"), "Bearer re_mock_transport_key")
        self.assertEqual(request.get_header("Content-type"), "application/json")
        self.assertEqual(request.get_header("Idempotency-key"), f"password-reset-code/{self.challenge_id}")
        self.assertEqual(self.transport.call_args.kwargs["timeout"], 10)
        payload = json.loads(request.data)
        self.assertEqual(payload["from"], "Folio <security@example.com>")
        self.assertEqual(payload["to"], [self.user.email])
        self.assertEqual(payload["reply_to"], "support@example.com")
        self.assertIn("003714", payload["text"])
        self.assertIn("003714", payload["html"])
        self.assertNotIn(self.user.nombre, payload["html"])
        self.assertIn("&lt;img", payload["html"])
        self.assertNotIn("re_mock_transport_key", request.data.decode())

    @override_settings(RESEND_REPLY_TO_EMAIL="")
    def test_optional_reply_address_is_omitted(self):
        self.send()
        self.assertNotIn("reply_to", json.loads(self.transport.call_args.args[0].data))

    def test_confirmation_is_separate_and_does_not_disclose_code_or_password(self):
        self.assertEqual(send_password_reset_confirmation(self.user, challenge_id=self.challenge_id), "mail-id")
        request = self.transport.call_args.args[0]
        self.assertEqual(request.get_header("Idempotency-key"), f"password-reset-confirmation/{self.challenge_id}")
        payload = json.loads(request.data)
        self.assertIn("contraseña", payload["subject"])
        for content in [payload["text"], payload["html"]]:
            self.assertNotIn(OLD_PASSWORD, content)
            self.assertNotIn(NEW_PASSWORD, content)
            self.assertNotIn("003714", content)

    def test_missing_or_invalid_configuration_fails_before_http(self):
        for values in [
            {"RESEND_API_KEY": ""}, {"RESEND_FROM_EMAIL": ""},
            {"RESEND_FROM_EMAIL": "invalid"},
            {"RESEND_FROM_EMAIL": "security@example.com\r\nBcc: bad@example.com"},
            {"RESEND_REPLY_TO_EMAIL": "invalid"},
            {"RESEND_TIMEOUT_SECONDS": 0}, {"RESEND_TIMEOUT_SECONDS": 61},
        ]:
            with self.subTest(values=values), override_settings(**values):
                with self.assertRaises(EmailConfigurationError):
                    self.send()
        self.transport.assert_not_called()

    def test_provider_http_error_is_sanitized_in_logs_and_public_exception(self):
        secret = "private-body-with-api-key"
        self.transport.side_effect = HTTPError("https://api.resend.com/emails", 403, secret, {}, BytesIO(secret.encode()))
        with self.assertLogs("core.emails", level="WARNING") as logs:
            with self.assertRaises(EmailDeliveryError) as caught:
                self.send()
        self.assertNotIn(secret, str(caught.exception))
        self.assertNotIn(secret, " ".join(logs.output))
        self.assertIn("403", " ".join(logs.output))

    def test_network_and_timeout_errors_are_handled_without_disclosing_details(self):
        for error in [URLError("private-network-details"), TimeoutError("private-timeout-details"), IncompleteRead(b"private-response-details", 100)]:
            with self.subTest(error=type(error).__name__):
                self.transport.side_effect = error
                with self.assertLogs("core.emails", level="WARNING") as logs:
                    with self.assertRaises(EmailDeliveryError) as caught:
                        self.send()
                self.assertNotIn("private-", str(caught.exception) + " ".join(logs.output))

    def test_malformed_or_unaccepted_provider_responses_are_rejected(self):
        for status, body in [
            (200, b"invalid JSON"), (200, b"[]"), (200, b"{}"),
            (200, b'{"id":null}'), (503, b'{"id":"not-accepted"}'),
        ]:
            with self.subTest(status=status, body=body):
                self.response.status = status
                self.response.read.return_value = body
                with self.assertRaises(EmailDeliveryError):
                    self.send()
