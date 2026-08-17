"""Typed wire envelope for reliable cloud control frames."""

from __future__ import annotations

import struct
import threading
import time
import zlib
from collections import deque
from dataclasses import dataclass


CAPABILITY_MARKER = b"WDR1"
MAGIC = b"WDRF"
VERSION = 1
KIND_REQUEST = 1
KIND_RESPONSE = 2
KIND_CANCEL = 3
FLAG_EXPECT_RESPONSE = 0x0001
MAX_PAYLOAD = 512
HEADER = struct.Struct("!4sBBHIII")


class ControlProtocolError(ValueError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class ControlFrame:
    kind: int
    flags: int
    transaction_id: int
    payload: bytes


@dataclass(frozen=True)
class ControlResult:
    status: str
    transaction_id: int = 0
    payload: bytes | None = None
    error: str | None = None


@dataclass
class PendingControl:
    owner: object
    transaction_id: int
    request: bytes
    response: bytes | None = None
    error: str | None = None


@dataclass(frozen=True)
class ControlPolicy:
    expect_response: bool
    timeout_s: float
    retries: int


def _validate_fields(kind: int, flags: int, transaction_id: int, payload: bytes) -> None:
    if kind not in (KIND_REQUEST, KIND_RESPONSE, KIND_CANCEL):
        raise ControlProtocolError("unsupported_kind")
    if flags & ~FLAG_EXPECT_RESPONSE:
        raise ControlProtocolError("unsupported_flags")
    if not 0 < transaction_id <= 0xFFFFFFFF:
        raise ControlProtocolError("invalid_transaction_id")
    if len(payload) > MAX_PAYLOAD:
        raise ControlProtocolError("payload_too_large")


def encode_frame(kind: int, flags: int, transaction_id: int, payload: bytes) -> bytes:
    body = bytes(payload or b"")
    _validate_fields(kind, flags, transaction_id, body)
    return HEADER.pack(
        MAGIC,
        VERSION,
        kind,
        flags,
        transaction_id,
        len(body),
        zlib.crc32(body) & 0xFFFFFFFF,
    ) + body


def encode_control_request(
    transaction_id: int,
    payload: bytes,
    expect_response: bool = True,
) -> bytes:
    flags = FLAG_EXPECT_RESPONSE if expect_response else 0
    return encode_frame(KIND_REQUEST, flags, transaction_id, payload)


def decode_frame(data: bytes) -> ControlFrame:
    wire = bytes(data or b"")
    if len(wire) < HEADER.size:
        raise ControlProtocolError("truncated_header")
    magic, version, kind, flags, transaction_id, payload_len, expected_crc = HEADER.unpack_from(wire)
    if magic != MAGIC:
        raise ControlProtocolError("bad_magic")
    if version != VERSION:
        raise ControlProtocolError("unsupported_version")
    if payload_len > MAX_PAYLOAD:
        raise ControlProtocolError("payload_too_large")
    if len(wire) != HEADER.size + payload_len:
        raise ControlProtocolError("length_mismatch")
    payload = wire[HEADER.size:]
    _validate_fields(kind, flags, transaction_id, payload)
    if zlib.crc32(payload) & 0xFFFFFFFF != expected_crc:
        raise ControlProtocolError("crc_mismatch")
    return ControlFrame(kind, flags, transaction_id, payload)


def _modbus_crc16(data: bytes) -> int:
    crc = 0xFFFF
    for value in data:
        crc ^= value
        for _ in range(8):
            crc = ((crc >> 1) ^ 0xA001) if crc & 1 else crc >> 1
    return crc


def classify_browser_control(data: bytes) -> ControlPolicy | None:
    frame = bytes(data or b"")
    if len(frame) < 4:
        return None
    expected_crc = frame[-2] | (frame[-1] << 8)
    if _modbus_crc16(frame[:-2]) != expected_crc:
        return None
    function = frame[1]
    if function in (0x03, 0x04):
        return ControlPolicy(True, 1.2, 1)
    if function in (0x06, 0x10):
        return ControlPolicy(True, 1.2, 0)
    if function in (0x08, 0x71, 0x72, 0x73, 0x75):
        return ControlPolicy(False, 0.0, 0)
    return None


class DeviceControlSession:
    def __init__(self, device_id: str) -> None:
        self.device_id = str(device_id)
        self._condition = threading.Condition()
        self._send_lock = threading.Lock()
        self._uplink = None
        self._capable = False
        self._pending: PendingControl | None = None
        self._next_transaction_id = 1
        self._expired_ids: deque[int] = deque(maxlen=64)

    @property
    def capable(self) -> bool:
        with self._condition:
            return self._capable and self._uplink is not None

    @property
    def inflight(self) -> bool:
        with self._condition:
            return self._pending is not None

    def attach_uplink(self, connection, capable: bool) -> None:
        with self._condition:
            changed = connection is not self._uplink or not capable
            self._uplink = connection
            self._capable = bool(capable and connection is not None)
            if changed and self._pending is not None:
                self._pending.error = "disconnected"
                self._pending = None
                self._condition.notify_all()

    def detach_uplink(self, connection) -> None:
        with self._condition:
            if connection is not self._uplink:
                return
            self._uplink = None
            self._capable = False
            if self._pending is not None:
                self._pending.error = "disconnected"
                self._pending = None
                self._condition.notify_all()

    def _allocate_transaction_id_locked(self) -> int:
        transaction_id = self._next_transaction_id
        self._next_transaction_id = (transaction_id + 1) & 0xFFFFFFFF
        if self._next_transaction_id == 0:
            self._next_transaction_id = 1
        return transaction_id

    def _send(self, connection, payload: bytes) -> bool:
        with self._send_lock:
            with self._condition:
                if connection is not self._uplink or not self._capable:
                    return False
            try:
                connection.send(payload)
                return True
            except Exception:
                with self._condition:
                    if connection is self._uplink:
                        self._uplink = None
                        self._capable = False
                        if self._pending is not None:
                            self._pending.error = "disconnected"
                            self._pending = None
                        self._condition.notify_all()
                return False

    def request(
        self,
        owner: object,
        payload: bytes,
        expect_response: bool,
        timeout_s: float,
        retries: int,
        on_retry=None,
    ) -> ControlResult:
        body = bytes(payload or b"")
        with self._condition:
            if not self._capable or self._uplink is None:
                return ControlResult("fallback")
            if self._pending is not None:
                return ControlResult("busy")
            transaction_id = self._allocate_transaction_id_locked()
            connection = self._uplink
            wire = encode_control_request(transaction_id, body, expect_response)
            pending = None
            if expect_response:
                pending = PendingControl(owner, transaction_id, wire)
                self._pending = pending

        if not expect_response:
            if self._send(connection, wire):
                return ControlResult("sent", transaction_id)
            return ControlResult("disconnected", transaction_id, error="disconnected")

        timeout = max(0.001, float(timeout_s))
        attempts = max(0, int(retries)) + 1
        for attempt in range(attempts):
            if not self._send(connection, wire):
                return ControlResult("disconnected", transaction_id, error="disconnected")
            deadline = time.monotonic() + timeout
            retrying = False
            with self._condition:
                while pending.response is None and pending.error is None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    self._condition.wait(remaining)
                if pending.response is not None:
                    if self._pending is pending:
                        self._pending = None
                    return ControlResult("ok", transaction_id, pending.response)
                if pending.error is not None or self._pending is not pending:
                    return ControlResult(
                        "disconnected", transaction_id, error=pending.error or "disconnected")
                if attempt + 1 < attempts:
                    retrying = True
                else:
                    self._pending = None
                    self._expired_ids.append(transaction_id)
            if retrying:
                if on_retry is not None:
                    on_retry(transaction_id)
                continue

        cancel = encode_frame(KIND_CANCEL, 0, transaction_id, b"")
        self._send(connection, cancel)
        return ControlResult("timeout", transaction_id, error="timeout")

    def accept_response(self, frame: ControlFrame) -> bool:
        with self._condition:
            if frame.kind != KIND_RESPONSE or frame.transaction_id in self._expired_ids:
                return False
            pending = self._pending
            if pending is None or pending.transaction_id != frame.transaction_id:
                return False
            pending.response = bytes(frame.payload)
            self._condition.notify_all()
            return True

    def release_owner(self, owner: object) -> None:
        connection = None
        transaction_id = 0
        with self._condition:
            pending = self._pending
            if pending is None or pending.owner is not owner:
                return
            pending.error = "disconnected"
            transaction_id = pending.transaction_id
            connection = self._uplink
            self._pending = None
            self._expired_ids.append(transaction_id)
            self._condition.notify_all()
        if connection is not None:
            self._send(connection, encode_frame(KIND_CANCEL, 0, transaction_id, b""))


def route_browser_control(
    session: DeviceControlSession,
    owner: object,
    payload: bytes,
    deliver,
    fallback,
    emit_status,
) -> ControlResult:
    data = bytes(payload or b"")
    policy = classify_browser_control(data)

    def use_fallback() -> ControlResult:
        emit_status("mqtt", "ready")
        fallback(data)
        return ControlResult("fallback")

    if policy is None or not session.capable:
        return use_fallback()

    emit_status("direct", "ready")
    result = session.request(
        owner,
        data,
        policy.expect_response,
        policy.timeout_s,
        policy.retries,
        on_retry=lambda transaction_id: emit_status("direct", "retry"),
    )
    if result.status == "ok" and result.payload is not None:
        if deliver(result.payload) is False:
            return ControlResult(
                "disconnected", result.transaction_id, error="browser_send_full")
    elif result.status == "busy":
        emit_status("direct", "busy")
    elif result.status == "timeout":
        emit_status("direct", "timeout")
    elif result.status == "fallback":
        return use_fallback()
    elif result.status == "disconnected":
        emit_status("direct", "timeout")
    return result
