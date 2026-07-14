"""Per-browser bounded send queues for real-time WebSocket waveform fan-out."""

from __future__ import annotations

import threading
import time
from collections import deque
from typing import Callable


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
