#!/usr/bin/env python3
"""Executable regression tests for serialized raw cloud WebSocket downlink."""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools" / "remote_mqtt_python"))

from ws_fanout import DeviceDownlinkRouter  # noqa: E402


class RecordingConnection:
    def __init__(self) -> None:
        self.sent: list[bytes] = []

    def send(self, payload: bytes) -> None:
        self.sent.append(bytes(payload))


class FailingConnection(RecordingConnection):
    def send(self, payload: bytes) -> None:
        raise ConnectionError("device uplink send failed")


class BlockingConnection(RecordingConnection):
    def __init__(self) -> None:
        super().__init__()
        self.first_started = threading.Event()
        self.release_first = threading.Event()
        self._guard = threading.Lock()
        self.active_sends = 0
        self.max_active_sends = 0
        self.send_calls = 0

    def send(self, payload: bytes) -> None:
        with self._guard:
            self.active_sends += 1
            self.max_active_sends = max(self.max_active_sends, self.active_sends)
            self.send_calls += 1
            call_number = self.send_calls
        if call_number == 1:
            self.first_started.set()
            assert self.release_first.wait(2), "timed out releasing first device send"
        self.sent.append(bytes(payload))
        with self._guard:
            self.active_sends -= 1


def run_thread(target):
    result: list[object] = []
    thread = threading.Thread(target=lambda: result.append(target()))
    thread.start()
    return thread, result


def test_same_device_sends_are_serialized() -> None:
    router = DeviceDownlinkRouter(max_frame_bytes=512)
    connection = BlockingConnection()
    assert router.attach("wd-test", connection) is None

    first, first_result = run_thread(lambda: router.send("wd-test", b"first"))
    assert connection.first_started.wait(1), "first send never reached the connection"
    second_started = threading.Event()

    def send_second():
        second_started.set()
        return router.send("wd-test", b"second")

    second, second_result = run_thread(send_second)
    assert second_started.wait(1)
    time.sleep(0.05)
    assert connection.send_calls == 1
    connection.release_first.set()
    first.join(2)
    second.join(2)

    assert not first.is_alive() and not second.is_alive()
    assert first_result == [(True, "sent")]
    assert second_result == [(True, "sent")]
    assert connection.sent == [b"first", b"second"]
    assert connection.max_active_sends == 1
    assert router.snapshot() == {
        "sent_frames": 2,
        "sent_bytes": 11,
        "dropped_frames": 0,
        "send_failures": 0,
    }


def test_different_devices_do_not_share_a_send_lock() -> None:
    router = DeviceDownlinkRouter(max_frame_bytes=512)
    blocked = BlockingConnection()
    other = RecordingConnection()
    router.attach("wd-a", blocked)
    router.attach("wd-b", other)

    first, _ = run_thread(lambda: router.send("wd-a", b"blocked"))
    assert blocked.first_started.wait(1)
    second, second_result = run_thread(lambda: router.send("wd-b", b"independent"))
    second.join(1)
    assert not second.is_alive(), "another device was blocked by a global send lock"
    assert second_result == [(True, "sent")]
    assert other.sent == [b"independent"]
    blocked.release_first.set()
    first.join(2)


def test_replacement_and_stale_detach_keep_new_connection() -> None:
    router = DeviceDownlinkRouter(max_frame_bytes=512)
    old = RecordingConnection()
    new = RecordingConnection()
    assert router.attach("wd-test", old) is None
    assert router.attach("wd-test", new) is old
    assert router.detach("wd-test", old) is False
    assert router.connected("wd-test") is True
    assert router.device_count() == 1
    assert router.send("wd-test", b"new") == (True, "sent")
    assert old.sent == []
    assert new.sent == [b"new"]
    assert router.detach("wd-test", new) is True
    assert router.connected("wd-test") is False


def test_replacement_waits_for_an_inflight_device_send() -> None:
    router = DeviceDownlinkRouter(max_frame_bytes=512)
    old = BlockingConnection()
    new = RecordingConnection()
    router.attach("wd-test", old)

    sending, send_result = run_thread(lambda: router.send("wd-test", b"old"))
    assert old.first_started.wait(1)
    replacing, replace_result = run_thread(lambda: router.attach("wd-test", new))
    time.sleep(0.05)
    assert replacing.is_alive(), "connection replacement bypassed the per-device send lock"
    assert new.sent == []

    old.release_first.set()
    sending.join(2)
    replacing.join(2)
    assert not sending.is_alive() and not replacing.is_alive()
    assert send_result == [(True, "sent")]
    assert replace_result == [old]
    assert router.send("wd-test", b"new") == (True, "sent")
    assert old.sent == [b"old"]
    assert new.sent == [b"new"]


def test_drop_and_failure_paths_are_bounded_without_fallback() -> None:
    router = DeviceDownlinkRouter(max_frame_bytes=4)
    assert router.send("missing", b"x") == (False, "uplink disconnected")
    router.attach("wd-test", RecordingConnection())
    assert router.send("wd-test", b"12345") == (False, "frame too large")
    router.attach("wd-test", FailingConnection())
    ok, reason = router.send("wd-test", b"fail")
    assert ok is False
    assert reason == "uplink send failed"
    assert router.snapshot() == {
        "sent_frames": 0,
        "sent_bytes": 0,
        "dropped_frames": 3,
        "send_failures": 1,
    }


test_same_device_sends_are_serialized()
test_different_devices_do_not_share_a_send_lock()
test_replacement_and_stale_detach_keep_new_connection()
test_replacement_waits_for_an_inflight_device_send()
test_drop_and_failure_paths_are_bounded_without_fallback()
print("cloud websocket downlink regression passed")
