#!/usr/bin/env python3
import json
import os
import statistics
import time

from websockets.sync.client import connect


URL = os.environ.get(
    "CLOUD_WS_URL",
    "ws://127.0.0.1:18089/ws/device/wd-ac276eab7c9c",
)
CYCLES = int(os.environ.get("CYCLES", "40"))
INTERVAL_SECONDS = int(os.environ.get("INTERVAL_MS", "500")) / 1000
TIMEOUT_SECONDS = int(os.environ.get("TIMEOUT_MS", "2800")) / 1000


def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for value in data:
        crc ^= value
        for _ in range(8):
            crc = ((crc >> 1) ^ 0xA001) if crc & 1 else crc >> 1
    return crc & 0xFFFF


def read_holding(start_address: int, count: int) -> bytes:
    body = bytes((
        0xFF,
        0x03,
        (start_address >> 8) & 0xFF,
        start_address & 0xFF,
        (count >> 8) & 0xFF,
        count & 0xFF,
    ))
    checksum = crc16(body)
    return body + bytes((checksum & 0xFF, checksum >> 8))


def find_response(buffer: bytes, register_count: int) -> tuple[bytes | None, bytes]:
    length = 5 + register_count * 2
    marker = bytes((0xFF, 0x03, register_count * 2))
    start = buffer.find(marker)
    if start < 0:
        return None, buffer[-2:]
    if len(buffer) - start < length:
        return None, buffer[start:]
    frame = buffer[start:start + length]
    expected_crc = frame[-2] | (frame[-1] << 8)
    if crc16(frame[:-2]) != expected_crc:
        return None, buffer[start + 1:]
    return frame, buffer[start + length:]


def wait_response(connection, register_count: int) -> None:
    deadline = time.monotonic() + TIMEOUT_SECONDS
    buffer = b""
    while time.monotonic() < deadline:
        message = connection.recv(timeout=max(0.001, deadline - time.monotonic()))
        if isinstance(message, str):
            continue
        buffer += bytes(message)
        frame, buffer = find_response(buffer, register_count)
        if frame is not None:
            return
    raise TimeoutError("modbus response timeout")


request = read_holding(0x0B00, 8)
latencies = []
timeouts = 0

with connect(URL, open_timeout=10, close_timeout=2) as ws:
    for _ in range(CYCLES):
        cycle_started = time.monotonic()
        ws.send(request)
        try:
            wait_response(ws, 8)
            latencies.append((time.monotonic() - cycle_started) * 1000)
        except TimeoutError:
            timeouts += 1
        remaining = INTERVAL_SECONDS - (time.monotonic() - cycle_started)
        if remaining > 0:
            time.sleep(remaining)

if timeouts or len(latencies) != CYCLES:
    raise SystemExit(f"missing responses: {len(latencies)}/{CYCLES}, timeouts={timeouts}")

ordered = sorted(latencies)
p95_index = min(len(ordered) - 1, int(len(ordered) * 0.95 + 0.999) - 1)
print(json.dumps({
    "requests": CYCLES,
    "responses": len(latencies),
    "timeouts": timeouts,
    "interval_ms": int(INTERVAL_SECONDS * 1000),
    "min_ms": round(min(latencies), 1),
    "median_ms": round(statistics.median(latencies), 1),
    "p95_ms": round(ordered[p95_index], 1),
    "max_ms": round(max(latencies), 1),
}, separators=(",", ":")))
