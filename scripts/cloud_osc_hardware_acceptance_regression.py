#!/usr/bin/env python3
import importlib.util
import asyncio
from copy import deepcopy
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("cloud_osc_hardware_acceptance.py")
spec = importlib.util.spec_from_file_location("cloud_osc_hardware_acceptance", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


assert module.append_crc(bytes.fromhex("ff7100000000")).hex() == "ff7100000000681f"
assert module.append_crc(bytes.fromhex("ff7200000000")).hex() == "ff72000000002c1f"
assert module.append_crc(bytes.fromhex("ff0800000000")).hex() == "ff0800000000f5d5"
assert module.HttpClient(use_proxy=False).proxy_handler.proxies == {}
assert module.HttpClient(use_proxy=True).proxy_handler.proxies != {}
assert module.websocket_connect_options(use_proxy=False)["proxy"] is None
assert "proxy" not in module.websocket_connect_options(use_proxy=True)
source = MODULE_PATH.read_text(encoding="utf-8")
assert "attempts = 3 if method == \"GET\" and body is None else 1" in source
assert "finally:\n        if mode == \"local\":\n            http.json(f\"{api_base}/api/comm/mode\"" in source
assert "raise RuntimeError(\"cloud status did not refresh\")" in source
assert "await preclean_stream(ws_url, connect, use_proxy=use_proxy)" in source
assert "await ws.send(STOP_FRAME)\n        await asyncio.sleep(1.0)" in source
assert source.index('injection["cloud_poll_after_seq"] = await mark_fallback_window()') < source.index(
    'replacement = await connect(')
assert source.index('fallback_poll = http.json(f"{remote_poll_url}?after={fallback_after_seq}")') < source.index(
    'after = refresh_cloud_status(')
assert 'capture_fallback_window=capture_fallback_window' in source
assert source.index('injection["cloud_poll_frames"] = await capture_fallback_window(') < source.index(
    'fallback_window_start = time.monotonic()')
assert 'deadline = time.monotonic() + 2.0' in source
assert 'heartbeat_sent_at' in source
assert 'injection["heartbeat"]' in source
assert 'cloud_health_before = http.json' in source
assert 'cloud_health_after = http.json' in source
assert 'cloud_health_deltas(cloud_health_before, cloud_health_after)' in source

module.ensure_current_firmware({"cloud_ws_uplink": {"schema_version": 6}})
try:
    module.ensure_current_firmware({"cloud_ws_uplink": {"schema_version": 5}})
except RuntimeError as exc:
    assert "schema 6" in str(exc)
else:
    raise AssertionError("uncompressed schema 5 firmware must be rejected")
try:
    module.ensure_current_firmware({})
except RuntimeError as exc:
    assert "latest firmware" in str(exc)
else:
    raise AssertionError("old firmware must be rejected before oscilloscope control")
assert source.index("ensure_current_firmware(current)") < source.index(
    "await preclean_stream(ws_url, connect, use_proxy=use_proxy)")

before = {
    "comm_stats": {
        "uart": {"rx_frames": 10, "rx_bytes": 10000, "overflows": 4},
        "wifi": {"pool_exhausted": 7, "queue_full": 2},
        "route": {"partial_drops": 3},
    },
    "cloud_ws_uplink": {
        "queued_frames": 10,
        "sent_frames": 8,
        "sent_bytes": 2048,
        "queue_pending_frames": 4,
        "queue_full": 1,
        "overload_dropped_frames": 1,
        "send_failures": 2,
        "fallback_frames": 3,
        "queued_fallback_frames": 2,
        "fallback_failures": 1,
        "stop_dropped_frames": 2,
        "compression_calls": 10,
        "compressed_frames": 8,
        "raw_envelope_frames": 2,
        "compression_failures": 1,
        "raw_bytes": 10000,
        "wire_bytes": 1000,
        "compression_total_us": 100,
        "send_calls": 10,
        "send_total_us": 100,
    },
}
after = {
    "comm_stats": {
        "uart": {"rx_frames": 14, "rx_bytes": 26000, "overflows": 5},
        "wifi": {"pool_exhausted": 9, "queue_full": 2},
        "route": {"partial_drops": 6},
    },
    "cloud_ws_uplink": {
        "queued_frames": 25,
        "sent_frames": 20,
        "sent_bytes": 8192,
        "queue_pending_frames": 5,
        "queue_full": 1,
        "overload_dropped_frames": 3,
        "send_failures": 4,
        "fallback_frames": 8,
        "queued_fallback_frames": 5,
        "fallback_failures": 1,
        "stop_dropped_frames": 3,
        "compression_calls": 30,
        "compressed_frames": 26,
        "raw_envelope_frames": 4,
        "compression_failures": 1,
        "raw_bytes": 250000,
        "wire_bytes": 13000,
        "compression_total_us": 5100,
        "send_calls": 30,
        "send_total_us": 5100,
    },
}
deltas = module.status_deltas(before, after)
assert deltas == {
    "uart_rx_frames": 4,
    "uart_rx_bytes": 16000,
    "uart_overflows": 1,
    "wifi_pool_exhausted": 2,
    "wifi_queue_full": 0,
    "route_partial_drops": 3,
    "uplink_queued_frames": 15,
    "uplink_sent_frames": 12,
    "uplink_sent_bytes": 6144,
    "uplink_queue_pending_frames": 1,
    "uplink_queue_full": 0,
    "uplink_overload_dropped_frames": 2,
    "uplink_send_failures": 2,
    "uplink_fallback_frames": 5,
    "uplink_queued_fallback_frames": 3,
    "uplink_fallback_failures": 0,
    "uplink_stop_dropped_frames": 1,
    "uplink_compression_calls": 20,
    "uplink_compressed_frames": 18,
    "uplink_raw_envelope_frames": 2,
    "uplink_compression_failures": 0,
    "uplink_raw_bytes": 240000,
    "uplink_wire_bytes": 12000,
    "uplink_compression_total_us": 5000,
    "uplink_send_calls": 20,
    "uplink_send_total_us": 5000,
}

good_compression_deltas = {
    "uplink_compression_calls": 20,
    "uplink_compressed_frames": 18,
    "uplink_raw_envelope_frames": 2,
    "uplink_compression_failures": 0,
    "uplink_raw_bytes": 240000,
    "uplink_wire_bytes": 12000,
    "uplink_compression_total_us": 40000,
}
good_uplink_after = {
    "compression_capable": True,
    "compression_active": True,
    "compression_max_us": 8000,
}
good_cloud_codec = {
    "compressed_messages": 20,
    "raw_envelope_messages": 0,
    "decode_failures": 0,
    "decode_total_us": 10000,
    "decode_max_us": 900,
}
good_heartbeat = {"count": 20, "p95_ms": 100.0, "max_ms": 200.0}

checks = module.compression_checks(
    good_compression_deltas,
    good_uplink_after,
    good_cloud_codec,
    good_heartbeat,
    browser_drop_delta=0,
    internal_min_free_heap=10000,
)
assert all(checks.values()), checks

boundary_cases = [
    ("wire_ratio_below_20_percent", "deltas", "uplink_wire_bytes", 48000),
    ("compression_average_us", "deltas", "uplink_compression_total_us", 100001),
    ("compression_max_us", "uplink", "compression_max_us", 10001),
    ("cloud_decode_average_us", "cloud", "decode_total_us", 20001),
    ("heartbeat_p95_ms", "heartbeat", "p95_ms", 500.01),
    ("heartbeat_max_ms", "heartbeat", "max_ms", 2000.0),
    ("internal_min_free_heap", "heap", "value", 8191),
    ("compression_no_failures", "deltas", "uplink_compression_failures", 1),
    ("cloud_decode_no_failure", "cloud", "decode_failures", 1),
    ("browser_pump_no_drop", "browser", "value", 1),
]
for check_name, target, key, value in boundary_cases:
    deltas_case = deepcopy(good_compression_deltas)
    uplink_case = deepcopy(good_uplink_after)
    cloud_case = deepcopy(good_cloud_codec)
    heartbeat_case = deepcopy(good_heartbeat)
    browser_drop = 0
    heap = 10000
    if target == "deltas":
        deltas_case[key] = value
    elif target == "uplink":
        uplink_case[key] = value
    elif target == "cloud":
        cloud_case[key] = value
    elif target == "heartbeat":
        heartbeat_case[key] = value
    elif target == "browser":
        browser_drop = value
    else:
        heap = value
    failed = module.compression_checks(
        deltas_case, uplink_case, cloud_case, heartbeat_case,
        browser_drop_delta=browser_drop,
        internal_min_free_heap=heap,
    )
    assert failed[check_name] is False, check_name

metrics = module.frame_metrics(
    [(0.000, 250), (0.010, 250), (0.020, 500), (0.060, 250)],
    duration=0.060,
)
assert metrics["frames"] == 4
assert metrics["bytes"] == 1250
assert metrics["bytes_per_second"] == 20833
assert metrics["interval_ms"]["median"] == 10.0
assert metrics["interval_ms"]["p95"] == 40.0
assert metrics["interval_ms"]["max"] == 40.0

poll = {
    "frames": [
        {"seq": 10, "payload_hex": "ff71"},
        {"seq": 11, "payload_hex": "aa" * 250},
        {"seq": 12, "payload_hex": "bb" * 8},
    ]
}
assert module.latest_remote_ws_seq(poll) == 12
assert module.count_remote_waveform_frames(poll) == 1

local = module.evaluate_result(
    "local",
    metrics={"frames": 100, "bytes": 25000, "bytes_per_second": 25000,
             "interval_ms": {"median": 8, "p95": 20, "max": 80}},
    deltas={
        "uart_overflows": 0,
        "wifi_pool_exhausted": 0,
        "wifi_queue_full": 0,
        "route_partial_drops": 0,
        "uplink_queued_frames": 0,
        "uplink_sent_frames": 0,
        "uplink_sent_bytes": 0,
        "uplink_queue_pending_frames": 0,
        "uplink_queue_full": 0,
        "uplink_overload_dropped_frames": 0,
        "uplink_send_failures": 0,
        "uplink_fallback_frames": 0,
        "uplink_queued_fallback_frames": 0,
        "uplink_fallback_failures": 0,
        "uplink_stop_dropped_frames": 0,
        **good_compression_deltas,
    },
    fallback_requested=False,
    min_bytes_per_second=15000,
    max_p95_ms=50,
    max_gap_ms=500,
)
assert local["passed"] is True

cloud = module.evaluate_result(
    "cloud",
    metrics={"frames": 100, "bytes": 25000, "bytes_per_second": 25000,
             "interval_ms": {"median": 8, "p95": 30, "max": 120}},
    deltas={
        "uart_overflows": 0,
        "wifi_pool_exhausted": 0,
        "wifi_queue_full": 0,
        "route_partial_drops": 0,
        "uplink_queued_frames": 100,
        "uplink_sent_frames": 95,
        "uplink_sent_bytes": 25000,
        "uplink_queue_pending_frames": 0,
        "uplink_queue_full": 0,
        "uplink_overload_dropped_frames": 0,
        "uplink_send_failures": 1,
        "uplink_fallback_frames": 5,
        "uplink_queued_fallback_frames": 5,
        "uplink_fallback_failures": 0,
        "uplink_stop_dropped_frames": 0,
        **good_compression_deltas,
    },
    fallback_requested=True,
    min_bytes_per_second=15000,
    max_p95_ms=100,
    max_gap_ms=750,
    fallback_window_frames=3,
    mqtt_poll_frames=2,
    fallback_injection_completed=True,
    uplink_schema_version=6,
    uplink_after=good_uplink_after,
    cloud_codec=good_cloud_codec,
    heartbeat=good_heartbeat,
    browser_drop_delta=0,
    internal_min_free_heap=10000,
)
assert cloud["passed"] is True

old_firmware = module.evaluate_result(
    "cloud",
    metrics={"frames": 100, "bytes": 25000, "bytes_per_second": 25000,
             "interval_ms": {"median": 8, "p95": 30, "max": 120}},
    deltas=cloud["checks"] and {
        "uart_overflows": 0,
        "uplink_queued_frames": 100,
        "uplink_sent_frames": 95,
        "uplink_sent_bytes": 25000,
        "uplink_queue_pending_frames": 0,
        "uplink_queue_full": 0,
        "uplink_overload_dropped_frames": 0,
        "uplink_queued_fallback_frames": 5,
        "uplink_fallback_frames": 5,
        "uplink_fallback_failures": 0,
        "uplink_stop_dropped_frames": 0,
    },
    fallback_requested=True,
    min_bytes_per_second=15000,
    max_p95_ms=100,
    max_gap_ms=750,
    fallback_window_frames=3,
    mqtt_poll_frames=2,
    fallback_injection_completed=True,
    uplink_schema_version=0,
)
assert old_firmware["passed"] is False
assert old_firmware["checks"]["uplink_schema_current"] is False

unaccounted = module.evaluate_result(
    "cloud",
    metrics={"frames": 100, "bytes": 25000, "bytes_per_second": 25000,
             "interval_ms": {"median": 8, "p95": 30, "max": 120}},
    deltas={
        "uart_overflows": 0,
        "wifi_pool_exhausted": 0,
        "wifi_queue_full": 0,
        "route_partial_drops": 0,
        "uplink_queued_frames": 100,
        "uplink_sent_frames": 70,
        "uplink_sent_bytes": 18000,
        "uplink_queue_pending_frames": 20,
        "uplink_queue_full": 0,
        "uplink_overload_dropped_frames": 0,
        "uplink_send_failures": 0,
        "uplink_fallback_frames": 4,
        "uplink_queued_fallback_frames": 4,
        "uplink_fallback_failures": 1,
        "uplink_stop_dropped_frames": 0,
        **good_compression_deltas,
    },
    fallback_requested=True,
    min_bytes_per_second=15000,
    max_p95_ms=100,
    max_gap_ms=750,
    fallback_window_frames=3,
    mqtt_poll_frames=2,
    fallback_injection_completed=True,
    uplink_schema_version=6,
    uplink_after=good_uplink_after,
    cloud_codec=good_cloud_codec,
    heartbeat=good_heartbeat,
    browser_drop_delta=0,
    internal_min_free_heap=10000,
)
assert unaccounted["passed"] is False
assert unaccounted["checks"]["uplink_frames_accounted"] is False
assert unaccounted["checks"]["mqtt_fallback_no_failures"] is False

slow = module.evaluate_result(
    "cloud",
    metrics={"frames": 2, "bytes": 500, "bytes_per_second": 40,
             "interval_ms": {"median": 900, "p95": 900, "max": 900}},
    deltas={
        "uart_overflows": 0,
        "wifi_pool_exhausted": 0,
        "wifi_queue_full": 0,
        "route_partial_drops": 0,
        "uplink_queued_frames": 2,
        "uplink_sent_frames": 2,
        "uplink_sent_bytes": 500,
        "uplink_queue_full": 0,
        "uplink_send_failures": 0,
        "uplink_fallback_frames": 1,
        "uplink_queued_fallback_frames": 0,
        "uplink_fallback_failures": 0,
        "uplink_stop_dropped_frames": 0,
    },
    fallback_requested=True,
    min_bytes_per_second=15000,
    max_p95_ms=100,
    max_gap_ms=750,
    fallback_window_frames=0,
    mqtt_poll_frames=0,
    fallback_injection_completed=False,
    uplink_schema_version=2,
)
assert slow["passed"] is False
assert slow["checks"]["minimum_throughput"] is False
assert slow["checks"]["p95_latency"] is False
assert slow["checks"]["maximum_gap"] is False
assert slow["checks"]["mqtt_fallback_reached_browser"] is False
assert slow["checks"]["mqtt_fallback_recorded_by_cloud"] is False
assert slow["checks"]["fallback_injection_completed"] is False


class FakeSocket:
    def __init__(self):
        self.sent = []
        self.closed = False
        self.messages = asyncio.Queue()

    async def send(self, payload):
        self.sent.append(bytes(payload))
        if bytes(payload) == module.START_FRAME:
            await self.messages.put(module.OSC_HEADER + bytes(246))
        elif bytes(payload) == module.HEARTBEAT_FRAME:
            midpoint = len(module.HEARTBEAT_FRAME) // 2
            await self.messages.put(module.HEARTBEAT_FRAME[:midpoint])
            await self.messages.put(
                module.HEARTBEAT_FRAME[midpoint:] + module.OSC_HEADER + bytes(246)
            )

    async def recv(self):
        return await self.messages.get()

    async def close(self):
        self.closed = True


async def verify_stream_control():
    browser = FakeSocket()
    replacements = []
    fallback_marks = []

    async def fake_connect(url, **kwargs):
        replacement = FakeSocket()
        replacements.append((url, kwargs, replacement))
        return replacement

    async def mark_fallback_window():
        fallback_marks.append("marked")
        return 77

    frames, injection = await module.run_stream(
        browser, duration=3.0, inject_fallback=True,
        uplink_url="ws://cloud/ws/uplink/device", connect=fake_connect,
        mark_fallback_window=mark_fallback_window)
    assert browser.sent[0] == module.STOP_FRAME
    assert browser.sent[1:5] == [
        module.set_channel_frame(1, param_type=0, address=0xC52C),
        module.set_channel_frame(2, param_type=0, address=0),
        module.set_channel_frame(3, param_type=0, address=0),
        module.set_channel_frame(4, param_type=0, address=0),
    ]
    assert module.START_FRAME in browser.sent
    assert module.HEARTBEAT_FRAME in browser.sent
    assert browser.sent[-1] == module.STOP_FRAME
    assert replacements and replacements[0][2].closed is True
    assert injection["completed"] is True
    assert injection["cloud_poll_after_seq"] == 77
    assert fallback_marks == ["marked"]
    assert injection["browser_frames"] >= 1
    assert injection["browser_waveform_frames"] >= 1
    assert injection["heartbeat"]["count"] >= 1
    assert injection["heartbeat"]["max_ms"] < 2000
    assert len(frames) >= 1


asyncio.run(verify_stream_control())

print("cloud osc hardware acceptance regression passed")
