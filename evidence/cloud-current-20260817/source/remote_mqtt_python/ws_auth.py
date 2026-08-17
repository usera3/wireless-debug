"""Authentication helpers shared by the cloud HTTP and WebSocket servers."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from collections.abc import Collection
from urllib.parse import parse_qs, unquote, urlparse


def _encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(f"{value}{padding}".encode("ascii"))


def issue_ws_ticket(
    *,
    secret: str,
    device_id: str,
    role: str,
    ttl_seconds: int,
    now: int | None = None,
) -> str:
    if not secret or not device_id or not role or ttl_seconds <= 0:
        raise ValueError("secret, device_id, role and a positive ttl are required")
    issued_at = int(time.time() if now is None else now)
    payload = json.dumps(
        {"v": 1, "device_id": device_id, "role": role, "exp": issued_at + ttl_seconds},
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    encoded_payload = _encode(payload)
    signature = hmac.new(secret.encode("utf-8"), encoded_payload.encode("ascii"), hashlib.sha256).digest()
    return f"{encoded_payload}.{_encode(signature)}"


def verify_ws_ticket(
    secret: str,
    token: str,
    device_id: str,
    role: str,
    *,
    now: int | None = None,
) -> bool:
    if not secret or not token or not device_id or not role:
        return False
    try:
        encoded_payload, encoded_signature = token.split(".", 1)
        supplied_signature = _decode(encoded_signature)
        expected_signature = hmac.new(
            secret.encode("utf-8"), encoded_payload.encode("ascii"), hashlib.sha256
        ).digest()
        if not hmac.compare_digest(supplied_signature, expected_signature):
            return False
        payload = json.loads(_decode(encoded_payload).decode("utf-8"))
        current_time = int(time.time() if now is None else now)
        return (
            payload.get("v") == 1
            and payload.get("device_id") == device_id
            and payload.get("role") == role
            and isinstance(payload.get("exp"), int)
            and payload["exp"] >= current_time
        )
    except (ValueError, TypeError, KeyError, UnicodeError, json.JSONDecodeError):
        return False


def origin_allowed(origin: str | None, allowed_origins: Collection[str]) -> bool:
    return bool(origin and origin in allowed_origins)


def browser_device_from_request(
    *,
    path: str,
    origin: str | None,
    allowed_origins: Collection[str],
    secret: str,
    now: int | None = None,
) -> str | None:
    if not origin_allowed(origin, allowed_origins):
        return None
    parsed = urlparse(path or "")
    prefix = "/ws/device/"
    if not parsed.path.startswith(prefix):
        return None
    device_id = unquote(parsed.path[len(prefix) :]).strip()
    if not device_id or "/" in device_id:
        return None
    token = (parse_qs(parsed.query, keep_blank_values=False).get("ticket") or [""])[0]
    return device_id if verify_ws_ticket(secret, token, device_id, "browser", now=now) else None


def uplink_device_from_request(
    path: str,
    authorization: str | None,
    expected_token: str,
) -> str | None:
    parsed = urlparse(path or "")
    prefix = "/ws/uplink/"
    if not parsed.path.startswith(prefix) or not expected_token:
        return None
    device_id = unquote(parsed.path[len(prefix) :]).strip()
    if not device_id or "/" in device_id:
        return None
    scheme, separator, supplied_token = str(authorization or "").partition(" ")
    if separator != " " or scheme.lower() != "bearer" or not supplied_token:
        return None
    return device_id if hmac.compare_digest(supplied_token, expected_token) else None
