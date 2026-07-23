"""Per-browser bounded send queues for real-time WebSocket waveform fan-out."""

from __future__ import annotations

import threading
import time
from collections import deque
from typing import Callable


class _DeviceDownlink:
    def __init__(self, connection=None) -> None:
        self.connection = connection
        self.send_lock = threading.Lock()


class DeviceDownlinkRouter:
    """Own active device connections and serialize sends per connection."""

    def __init__(self, max_frame_bytes: int = 512) -> None:
        self.max_frame_bytes = max(1, int(max_frame_bytes))
        self._lock = threading.RLock()
        self._devices: dict[str, _DeviceDownlink] = {}
        self._sent_frames = 0
        self._sent_bytes = 0
        self._dropped_frames = 0
        self._send_failures = 0

    def attach(self, device_id: str, connection):
        key = str(device_id)
        with self._lock:
            entry = self._devices.get(key)
            if entry is None:
                entry = _DeviceDownlink()
                self._devices[key] = entry
        with entry.send_lock:
            with self._lock:
                previous = entry.connection
                entry.connection = connection
        return previous

    def detach(self, device_id: str, connection) -> bool:
        key = str(device_id)
        with self._lock:
            entry = self._devices.get(key)
        if entry is None:
            return False
        with entry.send_lock:
            with self._lock:
                if entry.connection is not connection:
                    return False
                entry.connection = None
            return True

    def connected(self, device_id: str) -> bool:
        with self._lock:
            entry = self._devices.get(str(device_id))
            return entry is not None and entry.connection is not None

    def device_count(self) -> int:
        with self._lock:
            return sum(entry.connection is not None for entry in self._devices.values())

    def send(self, device_id: str, payload: bytes) -> tuple[bool, str]:
        data = bytes(payload or b"")
        if not data:
            self._note_drop()
            return False, "empty frame"
        if len(data) > self.max_frame_bytes:
            self._note_drop()
            return False, "frame too large"

        key = str(device_id)
        with self._lock:
            entry = self._devices.get(key)
        if entry is None:
            self._note_drop()
            return False, "uplink disconnected"

        with entry.send_lock:
            with self._lock:
                connection = entry.connection
            if connection is None:
                self._note_drop()
                return False, "uplink disconnected"
            try:
                connection.send(data)
            except Exception:
                with self._lock:
                    self._dropped_frames += 1
                    self._send_failures += 1
                return False, "uplink send failed"

            with self._lock:
                self._sent_frames += 1
                self._sent_bytes += len(data)
            return True, "sent"

    def snapshot(self) -> dict[str, int]:
        with self._lock:
            return {
                "sent_frames": self._sent_frames,
                "sent_bytes": self._sent_bytes,
                "dropped_frames": self._dropped_frames,
                "send_failures": self._send_failures,
            }

    def _note_drop(self) -> None:
        with self._lock:
            self._dropped_frames += 1


class BrowserSendPump:
    def __init__(self, connection, max_frames: int = 16,
                 on_error: Callable[[Exception], None] | None = None,
                 on_drop: Callable[[int], None] | None = None,
                 chunk_bytes: int = 0,
                 min_send_interval: float = 0.0) -> None:
        self.connection = connection
        self.max_frames = max(1, int(max_frames))
        self.on_error = on_error
        self.on_drop = on_drop
        self.chunk_bytes = max(0, int(chunk_bytes))
        self.min_send_interval = max(0.0, float(min_send_interval))
        self.dropped_frames = 0
        self._frames: deque[bytes] = deque()
        self._condition = threading.Condition()
        self._closed = False
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._last_send_at = 0.0

    def start(self) -> None:
        self._thread.start()

    def enqueue(self, payload: bytes) -> bool:
        data = bytes(payload or b"")
        if not data:
            return False
        with self._condition:
            if self._closed:
                return False
            if len(self._frames) >= self.max_frames:
                self._frames.popleft()
                self.dropped_frames += 1
                if self.on_drop is not None:
                    self.on_drop(1)
            self._frames.append(data)
            self._condition.notify()
        return True

    def close(self) -> None:
        with self._condition:
            self._closed = True
            self._frames.clear()
            self._condition.notify_all()

    def _run(self) -> None:
        while True:
            with self._condition:
                while not self._frames and not self._closed:
                    self._condition.wait()
                if self._closed:
                    return
                payload = self._frames.popleft()
            chunks = (
                [payload]
                if self.chunk_bytes <= 0 or len(payload) <= self.chunk_bytes
                else [payload[offset:offset + self.chunk_bytes]
                      for offset in range(0, len(payload), self.chunk_bytes)]
            )
            for chunk in chunks:
                delay = self.min_send_interval - (time.monotonic() - self._last_send_at)
                if delay > 0:
                    time.sleep(delay)
                try:
                    self.connection.send(chunk)
                    self._last_send_at = time.monotonic()
                except Exception as exc:
                    if self.on_error is not None:
                        self.on_error(exc)
                    self.close()
                    return
