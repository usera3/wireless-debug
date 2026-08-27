#!/usr/bin/env python3
"""Regression checks for non-blocking cloud WebSocket browser fan-out."""

from __future__ import annotations

import importlib.util
import threading
import time
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "tools" / "remote_mqtt_python" / "ws_fanout.py"
COMPOSE_PATH = ROOT / "tools" / "remote_mqtt_python" / "docker-compose.yml"


class RecordingConnection:
    def __init__(self, blocked: bool = False) -> None:
        self.sent: list[bytes] = []
        self.release = threading.Event()
        if not blocked:
            self.release.set()

    def send(self, payload: bytes) -> None:
        self.release.wait(timeout=2.0)
        self.sent.append(bytes(payload))


def load_module():
    spec = importlib.util.spec_from_file_location("ws_fanout", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load ws_fanout module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def wait_until(predicate, timeout: float = 1.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("condition did not become true")


def main() -> None:
    compose = COMPOSE_PATH.read_text(encoding="utf-8")
    assert re.search(r"CLOUD_WS_BROWSER_CHUNK_BYTES:.*:-2048", compose)
    assert re.search(r"CLOUD_WS_BROWSER_SEND_INTERVAL_MS:.*:-20", compose)
    module = load_module()
    drop_events: list[int] = []
    fast_connection = RecordingConnection()
    slow_connection = RecordingConnection(blocked=True)
    fast = module.BrowserSendPump(fast_connection, max_frames=8)
    slow = module.BrowserSendPump(
        slow_connection, max_frames=3, on_drop=lambda count: drop_events.append(count))
    fast.start()
    slow.start()

    started = time.monotonic()
    for index in range(8):
        payload = bytes([index])
        assert fast.enqueue(payload)
        assert slow.enqueue(payload)
    enqueue_elapsed = time.monotonic() - started
    assert enqueue_elapsed < 0.1, "slow browser must not block fan-out enqueue"

    wait_until(lambda: len(fast_connection.sent) == 8)
    assert fast_connection.sent == [bytes([index]) for index in range(8)]
    assert slow.dropped_frames > 0, "slow browser queue must drop stale frames when full"
    assert sum(drop_events) == slow.dropped_frames, "drop callback must preserve cumulative telemetry"

    slow_connection.release.set()
    wait_until(lambda: len(slow_connection.sent) >= 1)
    assert slow_connection.sent[-1] == bytes([7]), "slow browser must converge on newest waveform data"

    fast.close()
    slow.close()
    assert not fast.enqueue(b"late"), "closed sender must reject new frames"

    paced_connection = RecordingConnection()
    paced = module.BrowserSendPump(
        paced_connection,
        max_frames=16,
        chunk_bytes=4,
        min_send_interval=0.02,
    )
    paced.start()
    assert paced.enqueue(b"abcdefghijkl")
    wait_until(lambda: len(paced_connection.sent) == 3)
    assert paced_connection.sent == [b"abcd", b"efgh", b"ijkl"]
    paced.close()

    coalesced_connection = RecordingConnection()
    coalesced = module.BrowserSendPump(
        coalesced_connection,
        max_frames=16,
        chunk_bytes=8,
        min_send_interval=0.05,
    )
    coalesced.start()
    assert coalesced.enqueue(b"warm")
    wait_until(lambda: coalesced_connection.sent == [b"warm"])
    for payload in (b"ab", b"cd", b"ef", b"gh"):
        assert coalesced.enqueue(payload)
    wait_until(lambda: len(coalesced_connection.sent) >= 2)
    assert coalesced_connection.sent[1] == b"abcdefgh", (
        "small frames queued during pacing must share one browser send"
    )
    coalesced.close()
    print("cloud WebSocket fanout regression passed")


if __name__ == "__main__":
    main()
