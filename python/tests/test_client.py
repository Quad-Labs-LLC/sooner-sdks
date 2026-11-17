import io
import json
import socket
import unittest
from email.message import Message
from http.client import IncompleteRead
from unittest.mock import patch
from urllib.error import HTTPError, URLError

from sooner_email import Sooner, SoonerApiError

KEY = "sn_" + "x" * 32


class Response:
    def __init__(self, body, status=200, headers=None):
        self.status = status
        self.headers = headers or {}
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read(self, limit):
        return self.body[:limit]


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.client = Sooner(KEY)

    def test_send_preserves_payload_and_idempotency(self):
        with patch.object(self.client._opener, "open", return_value=Response(b'{"id":"email_1"}')) as opening:
            payload = {"from": "a@example.test", "to": ["b@example.test"], "subject": "Hello", "text": "Hi"}
            self.assertEqual(self.client.emails.send(payload, idempotency_key="order-1"), {"id": "email_1"})
            request = opening.call_args.args[0]
            self.assertEqual(request.full_url, "https://api.sooner.dev/emails")
            self.assertEqual(request.get_method(), "POST")
            self.assertEqual(request.get_header("Idempotency-key"), "order-1")
            self.assertEqual(json.loads(request.data), payload)

    def test_all_routes(self):
        cases = [
            (lambda: self.client.emails.send_batch([], idempotency_key="batch-1"), "POST", "/emails/batch"),
            (lambda: self.client.emails.list(limit=10, after="email_1"), "GET", "/emails?limit=10&after=email_1"),
            (lambda: self.client.emails.get("email_1"), "GET", "/emails/email_1"),
            (lambda: self.client.emails.reschedule("email_1", "in 1 hour"), "PATCH", "/emails/email_1"),
            (lambda: self.client.emails.cancel("email_1"), "POST", "/emails/email_1/cancel"),
        ]
        for operation, method, path in cases:
            with self.subTest(path=path), patch.object(self.client._opener, "open", return_value=Response(b'{}')) as opening:
                operation()
                request = opening.call_args.args[0]
                self.assertEqual(request.get_method(), method)
                self.assertEqual(request.full_url, "https://api.sooner.dev" + path)
                if method == "PATCH":
                    self.assertEqual(json.loads(request.data), {"scheduled_at": "in 1 hour"})

    def test_structured_http_errors(self):
        headers = Message()
        headers["Retry-After"] = "12"
        error = HTTPError("https://api.sooner.dev/emails", 429, "rate limit", headers, io.BytesIO(b'{"name":"rate_limit_exceeded","message":"Wait"}'))
        with patch.object(self.client._opener, "open", side_effect=error), self.assertRaises(SoonerApiError) as caught:
            self.client.emails.send({"to": "b@example.test"})
        self.assertEqual((caught.exception.status, caught.exception.code, caught.exception.retry_after), (429, "rate_limit_exceeded", "12"))

    def test_redirects_are_not_followed(self):
        from http.server import BaseHTTPRequestHandler, HTTPServer
        from threading import Thread

        requests = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                requests.append(self.path)
                self.send_response(307)
                self.send_header("Location", "/redirected")
                self.send_header("Content-Length", "0")
                self.end_headers()
            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            local = Sooner(KEY, base_url=f"http://127.0.0.1:{server.server_port}")
            with self.assertRaises(SoonerApiError) as caught:
                local.emails.send({"to": "b@example.test"})
            self.assertEqual(caught.exception.status, 307)
            self.assertEqual(requests, ["/emails"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_transport_failure_never_retries(self):
        for failure, code in [
            (socket.timeout(), "timeout"),
            (URLError(socket.timeout()), "timeout"),
            (URLError("unavailable"), "network_error"),
            (IncompleteRead(b"partial"), "network_error"),
        ]:
            with self.subTest(code=code), patch.object(self.client._opener, "open", side_effect=failure) as opening:
                with self.assertRaises(SoonerApiError) as caught:
                    self.client.emails.send({"to": "b@example.test"}, idempotency_key="same-key")
                self.assertEqual(caught.exception.code, code)
                self.assertEqual(caught.exception.status, 0)
                self.assertEqual(opening.call_count, 1)

    def test_interrupted_response_has_structured_error(self):
        response = Response(b'')
        with patch.object(self.client._opener, "open", return_value=response):
            with patch.object(response, "read", side_effect=IncompleteRead(b'{"id":')):
                with self.assertRaises(SoonerApiError) as caught:
                    self.client.emails.send({"to": "b@example.test"})
        self.assertEqual(caught.exception.code, "network_error")
        self.assertEqual(caught.exception.status, 0)

    def test_timeout_validation_and_configuration(self):
        for timeout in (0, -1, True, float("inf"), float("nan")):
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                Sooner(KEY, timeout=timeout)
        client = Sooner(KEY, timeout=5)
        with patch.object(client._opener, "open", return_value=Response(b'{"id":"e"}')) as opening:
            client.emails.get("e")
            self.assertEqual(opening.call_args.kwargs["timeout"], 5)

    def test_invalid_and_oversized_responses(self):
        for body, code in [(b'<html>Oops</html>', "invalid_response"), (b'[]', "invalid_response"), (b'x' * (2 * 1024 * 1024 + 1), "response_too_large")]:
            with self.subTest(code=code), patch.object(self.client._opener, "open", return_value=Response(body)):
                with self.assertRaises(SoonerApiError) as caught:
                    self.client.emails.get("email_1")
                self.assertEqual(caught.exception.code, code)

    def test_validation_prevents_network_access(self):
        for origin in [
            "http://example.com", "https://user:pass@example.com", "https://example.com/a",
            "https://example.com?q=x", "https://example.com#x", "file:///tmp/key",
            "https://example.com?", "https://example.com#", "https://example.com\\other",
            "https://example.com:99999", "https://example.com\n", "http://127.0.0.1.example.com",
        ]:
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                Sooner(KEY, base_url=origin)
        for value in ["../outside", "a/b", "a?b", "", "%2f"]:
            with self.subTest(identifier=value), self.assertRaises(ValueError):
                self.client.emails.get(value)
        for limit in [True, 0, 101, 1.5]:
            with self.subTest(limit=limit), self.assertRaises(ValueError):
                self.client.emails.list(limit=limit)
        with self.assertRaises(ValueError):
            self.client.emails.send({"to": "x@example.test"}, idempotency_key="x\r\nAuthorization: bad")


if __name__ == "__main__":
    unittest.main()
