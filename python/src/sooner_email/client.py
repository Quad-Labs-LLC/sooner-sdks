"""Synchronous, dependency-free HTTP client. Requests are attempted once."""
import ipaddress
import json
import math
import re
import socket
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from typing import Any, cast

from .types import BatchResult, Email, EmailId, EmailPage, SendEmail

MAX_RESPONSE_BYTES = 2 * 1024 * 1024


class SoonerApiError(Exception):
    """API or transport failure, with machine-readable code and HTTP metadata.

    A transport failure can occur after the API accepted a write. Reuse the same
    idempotency key when retrying a send or batch.
    """

    def __init__(self, status: int, code: str, message: str, retry_after: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.retry_after = retry_after


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _identifier(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", value):
        raise ValueError("Use a valid email identifier without paths or dot segments")
    return value


def _origin(value: str) -> str:
    if (not isinstance(value, str) or any(ord(char) < 33 for char in value)
            or any(char in value for char in "\\?#")):
        raise ValueError("base_url must be an HTTPS origin or a local loopback HTTP origin")
    parsed = urlsplit(value)
    try:
        local = parsed.hostname == "localhost" or ipaddress.ip_address(parsed.hostname or "").is_loopback
    except ValueError:
        local = False
    if (not parsed.hostname or parsed.username is not None or parsed.password is not None
            or parsed.query or parsed.fragment or parsed.path not in ("", "/")
            or (parsed.scheme != "https" and not (parsed.scheme == "http" and local))):
        raise ValueError("base_url must be an HTTPS origin or a local loopback HTTP origin")
    parsed.port  # Validate malformed or out-of-range ports before any I/O.
    return value.rstrip("/")


class Emails:
    def __init__(self, client: "Sooner"):
        self._client = client

    def send(self, payload: SendEmail, *, idempotency_key: str | None = None) -> EmailId:
        return cast(EmailId, self._client._request("POST", "/emails", payload, idempotency_key))

    def send_batch(self, payload: list[SendEmail], *, idempotency_key: str | None = None) -> BatchResult:
        return cast(BatchResult, self._client._request("POST", "/emails/batch", payload, idempotency_key))

    def list(self, *, limit: int = 20, after: str | None = None) -> EmailPage:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("limit must be an integer between 1 and 100")
        params: dict[str, str | int] = {"limit": limit}
        if after is not None:
            params["after"] = _identifier(after)
        return cast(EmailPage, self._client._request("GET", "/emails?" + urlencode(params)))

    def get(self, email_id: str) -> Email:
        return cast(Email, self._client._request("GET", "/emails/" + _identifier(email_id)))

    def reschedule(self, email_id: str, scheduled_at: str) -> EmailId:
        return cast(EmailId, self._client._request("PATCH", "/emails/" + _identifier(email_id), {"scheduled_at": scheduled_at}))

    def cancel(self, email_id: str) -> EmailId:
        return cast(EmailId, self._client._request("POST", "/emails/" + _identifier(email_id) + "/cancel"))


class Sooner:
    def __init__(self, api_key: str, *, base_url: str = "https://api.sooner.dev", timeout: float = 30):
        if not isinstance(api_key, str) or not re.fullmatch(r"sn_[A-Za-z0-9_-]{16,200}", api_key):
            raise ValueError("A Sooner API key starting with sn_ is required")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be a finite positive number of seconds")
        self._base_url = _origin(base_url)
        self._api_key = api_key
        self._timeout = timeout
        self._opener = build_opener(_NoRedirect())
        self.emails = Emails(self)

    def _request(self, method: str, path: str, body: Any = None, idempotency_key: str | None = None) -> dict[str, Any]:
        headers = {"Authorization": "Bearer " + self._api_key, "Accept": "application/json", "User-Agent": "sooner-python/0.1.0"}
        if idempotency_key is not None:
            if not isinstance(idempotency_key, str) or not re.fullmatch(r"[\x20-\x7e]{1,256}", idempotency_key):
                raise ValueError("idempotency_key must contain 1 to 256 printable ASCII characters")
            headers["Idempotency-Key"] = idempotency_key
        data = None
        if body is not None:
            data = json.dumps(body, allow_nan=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(self._base_url + path, data=data, headers=headers, method=method)
        try:
            try:
                response = self._opener.open(request, timeout=self._timeout)
            except HTTPError as error:
                response = error
            with response:
                status = response.status
                retry_after = response.headers.get("Retry-After")
                raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise SoonerApiError(status, "response_too_large", "Sooner returned an oversized response", retry_after)
            try:
                result = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                result = None
            if not 200 <= status < 300:
                code = result.get("name") if isinstance(result, dict) else None
                message = result.get("message") if isinstance(result, dict) else None
                raise SoonerApiError(status, code if isinstance(code, str) else "http_error", message if isinstance(message, str) else "Sooner returned an unsuccessful HTTP response", retry_after)
            if not isinstance(result, dict):
                raise SoonerApiError(status, "invalid_response", "Sooner returned an invalid JSON object")
            return result
        except (TimeoutError, socket.timeout):
            raise SoonerApiError(0, "timeout", "Sooner request timed out. A write may have been accepted. Reuse its idempotency key when retrying.") from None
        except URLError as error:
            timeout = isinstance(error.reason, TimeoutError)
            raise SoonerApiError(0, "timeout" if timeout else "network_error", "Sooner request could not complete. A write may have been accepted. Reuse its idempotency key when retrying.") from None
        except (OSError, HTTPException):
            raise SoonerApiError(0, "network_error", "Sooner request could not complete. A write may have been accepted. Reuse its idempotency key when retrying.") from None
