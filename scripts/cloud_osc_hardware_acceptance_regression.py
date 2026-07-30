#!/usr/bin/env python3
import importlib.util
import asyncio
from copy import deepcopy
import gzip
import hashlib
from pathlib import Path
from tempfile import TemporaryDirectory
import time


MODULE_PATH = Path(__file__).with_name("cloud_osc_hardware_acceptance.py")
spec = importlib.util.spec_from_file_location("cloud_osc_hardware_acceptance", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


assert module.append_crc(bytes.fromhex("ff7100000000")).hex() == "ff7100000000681f"
assert module.append_crc(bytes.fromhex("ff7200000000")).hex() == "ff72000000002c1f"
assert module.append_crc(bytes.fromhex("ff0800000000")).hex() == "ff0800000000f5d5"
assert module.set_rate_frame(2_000_000) == module.append_crc(
    bytes.fromhex("ff73") + (2_000_000).to_bytes(4, "big"))
assert module.HttpClient(use_proxy=False).proxy_handler.proxies == {}
assert module.HttpClient(use_proxy=True).proxy_handler.proxies != {}
assert module.websocket_connect_options(use_proxy=False)["proxy"] is None
assert "proxy" not in module.websocket_connect_options(use_proxy=True)
source = MODULE_PATH.read_text(encoding="utf-8")
assert "attempts = 3 if method == \"GET\" and body is None else 1" in source
finally_body = source[source.index("    finally:", source.index("async def async_main")):]
assert "if mode == \"local\":\n            http.json(f\"{api_base}/api/comm/mode\"" in finally_body
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
assert 'raw_sink=raw_stream' in source
assert '"stream_integrity": integrity' in source
assert 'await asyncio.to_thread(fetch_status)' in source
assert '"status_timeline": status_timeline' in source
assert '"cloud_health_timeline": cloud_health_timeline' in source
assert '"transport_timeline": injection.get("transport_timeline")' in source
assert '"keepalive_after": after.get("cloud_osc_keepalive")' in source
assert '"send_duration_ms"' in source
assert '"schedule_lag_ms"' in source

module.ensure_current_firmware({"cloud_ws_uplink": {"schema_version": 7}})
try:
    module.ensure_current_firmware({"cloud_ws_uplink": {"schema_version": 6}})
except RuntimeError as exc:
    assert "schema 7" in str(exc)
else:
    raise AssertionError("schema 6 firmware without byte ledgers must be rejected")
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
        "uart": {
            "rx_frames": 10, "rx_bytes": 10000, "overflows": 4,
            "tx_bytes": 800, "tx_failures": 2,
            "fifo_overflows": 1, "buffer_full_overflows": 3,
            "overflow_assemble_bytes": 100, "overflow_driver_bytes": 200,
            "dispatch_calls": 10, "dispatch_total_us": 1000,
            "cloud_route_calls": 10, "cloud_route_total_us": 300,
            "local_route_calls": 10, "local_route_total_us": 700,
        },
        "wifi": {"pool_exhausted": 7, "queue_full": 2},
        "route": {"partial_drops": 3},
    },
    "cloud_ws_uplink": {
        "queued_frames": 10,
        "queued_bytes": 2500,
        "sent_frames": 8,
        "sent_bytes": 2048,
        "queue_pending_frames": 4,
        "queue_pending_bytes": 1000,
        "queue_full": 1,
        "overload_dropped_frames": 1,
        "overload_dropped_bytes": 250,
        "rejected_frames": 1,
        "rejected_bytes": 250,
        "send_failures": 2,
        "fallback_frames": 3,
        "queued_fallback_frames": 2,
        "queued_fallback_bytes": 500,
        "fallback_failures": 1,
        "stop_dropped_frames": 2,
        "stop_dropped_bytes": 500,
        "compression_calls": 10,
        "compressed_frames": 8,
        "raw_envelope_frames": 2,
        "compression_failures": 1,
        "raw_bytes": 10000,
        "wire_bytes": 1000,
        "compression_total_us": 100,
        "send_calls": 10,
        "send_total_us": 100,
        "downlink_frames": 5,
        "downlink_bytes": 40,
        "downlink_failures": 1,
    },
}
after = {
    "comm_stats": {
        "uart": {
            "rx_frames": 14, "rx_bytes": 26000, "overflows": 5,
            "tx_bytes": 920, "tx_failures": 3,
            "fifo_overflows": 1, "buffer_full_overflows": 4,
            "overflow_assemble_bytes": 120, "overflow_driver_bytes": 250,
            "dispatch_calls": 14, "dispatch_total_us": 1800,
            "cloud_route_calls": 14, "cloud_route_total_us": 500,
            "local_route_calls": 14, "local_route_total_us": 1300,
        },
        "wifi": {"pool_exhausted": 9, "queue_full": 2},
        "route": {"partial_drops": 6},
    },
    "cloud_ws_uplink": {
        "queued_frames": 25,
        "queued_bytes": 6250,
        "sent_frames": 20,
        "sent_bytes": 8192,
        "queue_pending_frames": 5,
        "queue_pending_bytes": 1250,
        "queue_full": 1,
        "overload_dropped_frames": 3,
        "overload_dropped_bytes": 750,
        "rejected_frames": 3,
        "rejected_bytes": 750,
        "send_failures": 4,
        "fallback_frames": 8,
        "queued_fallback_frames": 5,
        "queued_fallback_bytes": 1250,
        "fallback_failures": 1,
        "stop_dropped_frames": 3,
        "stop_dropped_bytes": 750,
        "compression_calls": 30,
        "compressed_frames": 26,
        "raw_envelope_frames": 4,
        "compression_failures": 1,
        "raw_bytes": 250000,
        "wire_bytes": 13000,
        "compression_total_us": 5100,
        "send_calls": 30,
        "send_total_us": 5100,
        "queue_dequeue_age_max_us": 120000,
        "queue_batch_ready_age_max_us": 125000,
        "queue_send_start_age_max_us": 134000,
        "queue_drop_age_max_us": 0,
        "batch_wait_max_us": 40000,
        "compression_max_us": 9000,
        "send_max_us": 399556,
        "ws_data_lock_wait_max_us": 2500,
        "ws_data_lock_timeouts": 0,
        "ws_transport_send_max_us": 397000,
        "ws_ping_lock_wait_max_us": 1800,
        "ws_ping_lock_timeouts": 0,
        "ws_ping_send_max_us": 1200,
        "downlink_frames": 12,
        "downlink_bytes": 96,
        "downlink_failures": 1,
    },
    "cloud_osc_keepalive": {
        "active": True,
        "sent": 4,
        "failures": 0,
        "expirations": 0,
        "lease_remaining_ms": 29000,
        "heartbeat_due_ms": 800,
    },
}
deltas = module.status_deltas(before, after)
assert deltas == {
    "uart_rx_frames": 4,
    "uart_rx_bytes": 16000,
    "uart_tx_bytes": 120,
    "uart_tx_failures": 1,
    "uart_overflows": 1,
    "uart_fifo_overflows": 0,
    "uart_buffer_full_overflows": 1,
    "uart_overflow_assemble_bytes": 20,
    "uart_overflow_driver_bytes": 50,
    "uart_dispatch_calls": 4,
    "uart_dispatch_total_us": 800,
    "uart_cloud_route_calls": 4,
    "uart_cloud_route_total_us": 200,
    "uart_local_route_calls": 4,
    "uart_local_route_total_us": 600,
    "wifi_pool_exhausted": 2,
    "wifi_queue_full": 0,
    "route_partial_drops": 3,
    "uplink_queued_frames": 15,
    "uplink_queued_bytes": 3750,
    "uplink_sent_frames": 12,
    "uplink_sent_bytes": 6144,
    "uplink_queue_pending_frames": 1,
    "uplink_queue_pending_bytes": 250,
    "uplink_queue_full": 0,
    "uplink_overload_dropped_frames": 2,
    "uplink_overload_dropped_bytes": 500,
    "uplink_rejected_frames": 2,
    "uplink_rejected_bytes": 500,
    "uplink_send_failures": 2,
    "uplink_fallback_frames": 5,
    "uplink_queued_fallback_frames": 3,
    "uplink_queued_fallback_bytes": 750,
    "uplink_fallback_failures": 0,
    "uplink_stop_dropped_frames": 1,
    "uplink_stop_dropped_bytes": 250,
    "uplink_compression_calls": 20,
    "uplink_compressed_frames": 18,
    "uplink_raw_envelope_frames": 2,
    "uplink_compression_failures": 0,
    "uplink_raw_bytes": 240000,
    "uplink_wire_bytes": 12000,
    "uplink_compression_total_us": 5000,
    "uplink_send_calls": 20,
    "uplink_send_total_us": 5000,
    "uplink_downlink_frames": 7,
    "uplink_downlink_bytes": 56,
    "uplink_downlink_failures": 0,
}

timeline_point = module.status_timeline_point(after, 1.23456)
assert timeline_point == {
    "at_seconds": 1.235,
    "uptime_ms": 0,
    "uart_rx_frames": 14,
    "uart_rx_bytes": 26000,
    "uart_tx_bytes": 920,
    "uart_tx_failures": 3,
    "uart_overflows": 5,
    "uplink_downlink_frames": 12,
    "uplink_downlink_bytes": 96,
    "uplink_downlink_failures": 1,
    "uplink_queued_frames": 25,
    "uplink_queued_bytes": 6250,
    "uplink_sent_frames": 20,
    "uplink_sent_bytes": 8192,
    "uplink_queue_pending_frames": 5,
    "uplink_queue_pending_bytes": 1250,
    "uplink_send_calls": 30,
    "uplink_send_total_us": 5100,
    "uplink_queue_dequeue_age_max_us": 120000,
    "uplink_queue_batch_ready_age_max_us": 125000,
    "uplink_queue_send_start_age_max_us": 134000,
    "uplink_queue_drop_age_max_us": 0,
    "uplink_batch_wait_max_us": 40000,
    "uplink_compression_max_us": 9000,
    "uplink_send_max_us": 399556,
    "uplink_ws_data_lock_wait_max_us": 2500,
    "uplink_ws_data_lock_timeouts": 0,
    "uplink_ws_transport_send_max_us": 397000,
    "uplink_ws_ping_lock_wait_max_us": 1800,
    "uplink_ws_ping_lock_timeouts": 0,
    "uplink_ws_ping_send_max_us": 1200,
    "keepalive_active": True,
    "keepalive_sent": 4,
    "keepalive_failures": 0,
    "keepalive_expirations": 0,
    "keepalive_lease_remaining_ms": 29000,
    "keepalive_heartbeat_due_ms": 800,
}


async def verify_status_timeline_sampler():
    stop = asyncio.Event()
    calls = 0

    def fetch_status():
        nonlocal calls
        calls += 1
        time.sleep(0.02)
        return {
            "uptime_ms": calls * 1000,
            "comm_stats": {"uart": {"rx_bytes": calls * 100}},
            "cloud_ws_uplink": {"downlink_frames": calls},
        }

    async def stop_soon():
        await asyncio.sleep(0.065)
        stop.set()

    stopper = asyncio.create_task(stop_soon())
    started = time.monotonic()
    timeline = await module.sample_status_timeline(
        fetch_status, stop, sample_interval=0.01, started_at=started)
    await stopper
    assert calls >= 2
    assert len(timeline) == calls
    assert timeline[0]["uart_rx_bytes"] == 100
    assert timeline[-1]["uplink_downlink_frames"] == calls
    assert timeline[-1]["at_seconds"] >= 0.02
    assert timeline[0]["fetch_duration_ms"] >= 20
    assert timeline[0]["fetch_started_at_seconds"] >= 0


asyncio.run(verify_status_timeline_sampler())

health_point = module.cloud_health_timeline_point({
    "ws_uplink_devices": 1,
    "ws_browser_clients": 2,
    "ws_downlink_sent_frames": 10,
    "ws_downlink_sent_bytes": 80,
    "ws_downlink_dropped_frames": 3,
    "ws_downlink_send_failures": 1,
    "waveform_codec": {
        "decoded_raw_bytes": 4096,
        "compressed_messages": 5,
        "raw_envelope_messages": 2,
        "legacy_raw_messages": 1,
    },
}, 2.3456)
assert health_point == {
    "at_seconds": 2.346,
    "ws_uplink_devices": 1,
    "ws_browser_clients": 2,
    "ws_downlink_sent_frames": 10,
    "ws_downlink_sent_bytes": 80,
    "ws_downlink_dropped_frames": 3,
    "ws_downlink_send_failures": 1,
    "waveform_decoded_raw_bytes": 4096,
    "waveform_compressed_messages": 5,
    "waveform_raw_envelope_messages": 2,
    "waveform_legacy_raw_messages": 1,
}


async def verify_cloud_health_timeline_sampler():
    stop = asyncio.Event()
    calls = 0

    def fetch_health():
        nonlocal calls
        calls += 1
        return {
            "ws_downlink_sent_frames": calls,
            "waveform_codec": {"decoded_raw_bytes": calls * 1000},
        }

    async def stop_soon():
        await asyncio.sleep(0.035)
        stop.set()

    stopper = asyncio.create_task(stop_soon())
    timeline = await module.sample_cloud_health_timeline(
        fetch_health, stop, sample_interval=0.01, started_at=time.monotonic())
    await stopper
    assert calls >= 2
    assert timeline[-1]["ws_downlink_sent_frames"] == calls
    assert timeline[-1]["waveform_decoded_raw_bytes"] == calls * 1000


asyncio.run(verify_cloud_health_timeline_sampler())

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


def signed16(value):
    return ((value + 32768) % 65536) - 32768


def make_osc_block(first_value, *, footer_anchored=False):
    payload = bytearray()
    for sample_offset in range(30):
        value = signed16(first_value + sample_offset)
        for _ in range(4):
            payload.extend(value.to_bytes(2, "big", signed=True))
    assert len(payload) == 240

    block = bytearray(250)
    block[:4] = bytes.fromhex("5f0501f4") if footer_anchored else module.OSC_HEADER
    block[4:244] = payload
    crc = module.crc16(payload)
    block[244:246] = bytes((crc & 0xFF, (crc >> 8) & 0xFF))
    block[246:250] = module.OSC_HEADER if footer_anchored else bytes(4)
    return bytes(block)


continuous_stream = (
    b"noise" +
    make_osc_block(32760) +
    module.HEARTBEAT_FRAME +
    make_osc_block(signed16(32760 + 30), footer_anchored=True)
)
continuous = module.osc_stream_integrity(continuous_stream)
assert continuous["logical_frames"] == 2
assert continuous["header_anchored_frames"] == 1
assert continuous["footer_anchored_frames"] == 1
assert continuous["samples"] == 60
assert continuous["checked_transitions"] == 59
assert continuous["discontinuity_count"] == 0
assert continuous["implied_missing_samples"] == 0
assert continuous["discarded_bytes"] == len(b"noise") + len(module.HEARTBEAT_FRAME)

with TemporaryDirectory() as temp_dir:
    raw_path = Path(temp_dir) / "cloud-waveform.bin.gz"
    raw_metadata = module.write_raw_capture(continuous_stream, raw_path)
    assert gzip.decompress(raw_path.read_bytes()) == continuous_stream
    assert raw_metadata == {
        "path": str(raw_path),
        "bytes": len(continuous_stream),
        "sha256": hashlib.sha256(continuous_stream).hexdigest(),
    }

gapped_stream = make_osc_block(100) + make_osc_block(140, footer_anchored=True)
gapped = module.osc_stream_integrity(gapped_stream)
assert gapped["logical_frames"] == 2
assert gapped["samples"] == 60
assert gapped["discontinuity_count"] == 1
assert gapped["implied_missing_samples"] == 10
assert gapped["first_discontinuities"] == [{
    "sample_index": 30,
    "previous": 129,
    "actual": 140,
    "modulo_step": 11,
    "implied_missing_samples": 10,
    "stream_offset": 250,
}]

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
        "uplink_queued_bytes": 25000,
        "uplink_sent_frames": 95,
        "uplink_sent_bytes": 23750,
        "uplink_queue_pending_frames": 0,
        "uplink_queue_pending_bytes": 0,
        "uplink_queue_full": 0,
        "uplink_overload_dropped_frames": 0,
        "uplink_overload_dropped_bytes": 0,
        "uplink_rejected_frames": 0,
        "uplink_rejected_bytes": 0,
        "uplink_send_failures": 1,
        "uplink_fallback_frames": 5,
        "uplink_queued_fallback_frames": 5,
        "uplink_queued_fallback_bytes": 1250,
        "uplink_fallback_failures": 0,
        "uplink_stop_dropped_frames": 0,
        "uplink_stop_dropped_bytes": 0,
        **good_compression_deltas,
    },
    fallback_requested=True,
    min_bytes_per_second=15000,
    max_p95_ms=100,
    max_gap_ms=750,
    fallback_window_frames=3,
    mqtt_poll_frames=2,
    fallback_injection_completed=True,
    uplink_schema_version=7,
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
        "uplink_queued_bytes": 25000,
        "uplink_sent_frames": 95,
        "uplink_sent_bytes": 23750,
        "uplink_queue_pending_frames": 0,
        "uplink_queue_pending_bytes": 0,
        "uplink_queue_full": 0,
        "uplink_overload_dropped_frames": 0,
        "uplink_overload_dropped_bytes": 0,
        "uplink_rejected_frames": 0,
        "uplink_rejected_bytes": 0,
        "uplink_queued_fallback_frames": 5,
        "uplink_queued_fallback_bytes": 1250,
        "uplink_fallback_frames": 5,
        "uplink_fallback_failures": 0,
        "uplink_stop_dropped_frames": 0,
        "uplink_stop_dropped_bytes": 0,
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
        "uplink_queued_bytes": 25000,
        "uplink_sent_frames": 70,
        "uplink_sent_bytes": 18000,
        "uplink_queue_pending_frames": 20,
        "uplink_queue_pending_bytes": 5000,
        "uplink_queue_full": 0,
        "uplink_overload_dropped_frames": 0,
        "uplink_overload_dropped_bytes": 0,
        "uplink_rejected_frames": 0,
        "uplink_rejected_bytes": 0,
        "uplink_send_failures": 0,
        "uplink_fallback_frames": 4,
        "uplink_queued_fallback_frames": 4,
        "uplink_queued_fallback_bytes": 1000,
        "uplink_fallback_failures": 1,
        "uplink_stop_dropped_frames": 0,
        "uplink_stop_dropped_bytes": 0,
        **good_compression_deltas,
    },
    fallback_requested=True,
    min_bytes_per_second=15000,
    max_p95_ms=100,
    max_gap_ms=750,
    fallback_window_frames=3,
    mqtt_poll_frames=2,
    fallback_injection_completed=True,
    uplink_schema_version=7,
    uplink_after=good_uplink_after,
    cloud_codec=good_cloud_codec,
    heartbeat=good_heartbeat,
    browser_drop_delta=0,
    internal_min_free_heap=10000,
)
assert unaccounted["passed"] is False
assert unaccounted["checks"]["uplink_frames_accounted"] is False
assert unaccounted["checks"]["uplink_bytes_accounted"] is False
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
        "uplink_queued_bytes": 500,
        "uplink_sent_frames": 2,
        "uplink_sent_bytes": 500,
        "uplink_queue_pending_frames": 0,
        "uplink_queue_pending_bytes": 0,
        "uplink_queue_full": 0,
        "uplink_send_failures": 0,
        "uplink_fallback_frames": 1,
        "uplink_queued_fallback_frames": 0,
        "uplink_queued_fallback_bytes": 0,
        "uplink_overload_dropped_frames": 0,
        "uplink_overload_dropped_bytes": 0,
        "uplink_rejected_frames": 0,
        "uplink_rejected_bytes": 0,
        "uplink_fallback_failures": 0,
        "uplink_stop_dropped_frames": 0,
        "uplink_stop_dropped_bytes": 0,
    },
    fallback_requested=True,
    min_bytes_per_second=15000,
    max_p95_ms=100,
    max_gap_ms=750,
    fallback_window_frames=0,
    mqtt_poll_frames=0,
    fallback_injection_completed=False,
    uplink_schema_version=6,
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
    raw_stream = bytearray()

    async def fake_connect(url, **kwargs):
        replacement = FakeSocket()
        replacements.append((url, kwargs, replacement))
        return replacement

    async def mark_fallback_window():
        fallback_marks.append("marked")
        return 77

    frames, injection = await module.run_stream(
        browser, duration=4.0, inject_fallback=True,
        uplink_url="ws://cloud/ws/uplink/device", connect=fake_connect,
        mark_fallback_window=mark_fallback_window,
        raw_sink=raw_stream,
        comm_rate_limit=2_000_000,
        heartbeat_interval=0.5,
        timeline_origin=time.monotonic())
    assert browser.sent[0] == module.STOP_FRAME
    assert browser.sent[1:5] == [
        module.set_channel_frame(1, param_type=0, address=0xC52C),
        module.set_channel_frame(2, param_type=0, address=0),
        module.set_channel_frame(3, param_type=0, address=0),
        module.set_channel_frame(4, param_type=0, address=0),
    ]
    assert browser.sent[5] == module.set_rate_frame(2_000_000)
    assert browser.sent.index(module.set_rate_frame(2_000_000)) < browser.sent.index(module.START_FRAME)
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
    assert injection["heartbeat"]["sent"] >= 2
    assert injection["heartbeat"]["responses"] >= 1
    assert injection["heartbeat"]["send_duration_max_ms"] >= 0
    timeline = injection["transport_timeline"]
    labels = [event["label"] for event in timeline["control_sends"]]
    assert labels[:5] == [
        "stop_before_start", "set_channel_1", "set_channel_2",
        "set_channel_3", "set_channel_4",
    ]
    assert labels[-1] == "stop_after_stream"
    heartbeats = [
        event for event in timeline["control_sends"]
        if event["label"] == "heartbeat"
    ]
    assert heartbeats[0]["scheduled_at_seconds"] <= heartbeats[0]["send_started_at_seconds"]
    assert heartbeats[0]["send_completed_at_seconds"] >= heartbeats[0]["send_started_at_seconds"]
    assert "round_trip_ms" in heartbeats[0]
    assert timeline["receives"]
    assert sum(event["heartbeat_matches"] for event in timeline["receives"]) >= 1
    assert len(frames) >= 1
    assert module.OSC_HEADER in raw_stream


asyncio.run(verify_stream_control())

print("cloud osc hardware acceptance regression passed")
