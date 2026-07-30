#!/usr/bin/env python3
"""Run repeatable local/cloud address-oscilloscope hardware acceptance tests."""

from __future__ import annotations

import argparse
import asyncio
import base64
from collections import deque
import gzip
import hashlib
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import http.client
from pathlib import Path
from typing import Any, Callable


OSC_HEADER = bytes.fromhex("ff77aa55")
START_FRAME = bytes.fromhex("ff7100000000681f")
STOP_FRAME = bytes.fromhex("ff72000000002c1f")
HEARTBEAT_FRAME = bytes.fromhex("ff0800000000f5d5")
OSC_CHANNEL_CONFIG = (
    (0, 0xC52C),
    (0, 0),
    (0, 0),
    (0, 0),
)


def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for value in data:
        crc ^= value
        for _ in range(8):
            crc = ((crc >> 1) ^ 0xA001) if crc & 1 else crc >> 1
    return crc


def append_crc(payload: bytes) -> bytes:
    crc = crc16(payload)
    return payload + bytes((crc & 0xFF, (crc >> 8) & 0xFF))


def set_channel_frame(channel: int, param_type: int = 0, address: int = 0) -> bytes:
    return append_crc(bytes((0xFF, 0x75, channel, param_type,
                             (address >> 8) & 0xFF, address & 0xFF)))


def set_rate_frame(bits_per_second: int) -> bytes:
    if not 0 <= bits_per_second <= 0xFFFFFFFF:
        raise ValueError("bits_per_second must fit uint32")
    return append_crc(bytes((0xFF, 0x73)) + bits_per_second.to_bytes(4, "big"))


def websocket_connect_options(use_proxy: bool = False) -> dict[str, Any]:
    options = {
        "open_timeout": 8,
        "close_timeout": 3,
        "max_size": 4 * 1024 * 1024,
    }
    if not use_proxy:
        options["proxy"] = None
    return options


def nested_int(payload: dict[str, Any], *path: str) -> int:
    value: Any = payload
    for key in path:
        if not isinstance(value, dict):
            return 0
        value = value.get(key)
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def status_deltas(before: dict[str, Any], after: dict[str, Any]) -> dict[str, int]:
    fields = {
        "uart_rx_frames": ("comm_stats", "uart", "rx_frames"),
        "uart_rx_bytes": ("comm_stats", "uart", "rx_bytes"),
        "uart_tx_bytes": ("comm_stats", "uart", "tx_bytes"),
        "uart_tx_failures": ("comm_stats", "uart", "tx_failures"),
        "uart_overflows": ("comm_stats", "uart", "overflows"),
        "uart_fifo_overflows": ("comm_stats", "uart", "fifo_overflows"),
        "uart_buffer_full_overflows": ("comm_stats", "uart", "buffer_full_overflows"),
        "uart_overflow_assemble_bytes": ("comm_stats", "uart", "overflow_assemble_bytes"),
        "uart_overflow_driver_bytes": ("comm_stats", "uart", "overflow_driver_bytes"),
        "uart_dispatch_calls": ("comm_stats", "uart", "dispatch_calls"),
        "uart_dispatch_total_us": ("comm_stats", "uart", "dispatch_total_us"),
        "uart_cloud_route_calls": ("comm_stats", "uart", "cloud_route_calls"),
        "uart_cloud_route_total_us": ("comm_stats", "uart", "cloud_route_total_us"),
        "uart_local_route_calls": ("comm_stats", "uart", "local_route_calls"),
        "uart_local_route_total_us": ("comm_stats", "uart", "local_route_total_us"),
        "wifi_pool_exhausted": ("comm_stats", "wifi", "pool_exhausted"),
        "wifi_queue_full": ("comm_stats", "wifi", "queue_full"),
        "route_partial_drops": ("comm_stats", "route", "partial_drops"),
        "uplink_queued_frames": ("cloud_ws_uplink", "queued_frames"),
        "uplink_queued_bytes": ("cloud_ws_uplink", "queued_bytes"),
        "uplink_sent_frames": ("cloud_ws_uplink", "sent_frames"),
        "uplink_sent_bytes": ("cloud_ws_uplink", "sent_bytes"),
        "uplink_queue_pending_frames": ("cloud_ws_uplink", "queue_pending_frames"),
        "uplink_queue_pending_bytes": ("cloud_ws_uplink", "queue_pending_bytes"),
        "uplink_queue_full": ("cloud_ws_uplink", "queue_full"),
        "uplink_overload_dropped_frames": ("cloud_ws_uplink", "overload_dropped_frames"),
        "uplink_overload_dropped_bytes": ("cloud_ws_uplink", "overload_dropped_bytes"),
        "uplink_rejected_frames": ("cloud_ws_uplink", "rejected_frames"),
        "uplink_rejected_bytes": ("cloud_ws_uplink", "rejected_bytes"),
        "uplink_send_failures": ("cloud_ws_uplink", "send_failures"),
        "uplink_fallback_frames": ("cloud_ws_uplink", "fallback_frames"),
        "uplink_queued_fallback_frames": ("cloud_ws_uplink", "queued_fallback_frames"),
        "uplink_queued_fallback_bytes": ("cloud_ws_uplink", "queued_fallback_bytes"),
        "uplink_fallback_failures": ("cloud_ws_uplink", "fallback_failures"),
        "uplink_stop_dropped_frames": ("cloud_ws_uplink", "stop_dropped_frames"),
        "uplink_stop_dropped_bytes": ("cloud_ws_uplink", "stop_dropped_bytes"),
        "uplink_compression_calls": ("cloud_ws_uplink", "compression_calls"),
        "uplink_compressed_frames": ("cloud_ws_uplink", "compressed_frames"),
        "uplink_raw_envelope_frames": ("cloud_ws_uplink", "raw_envelope_frames"),
        "uplink_compression_failures": ("cloud_ws_uplink", "compression_failures"),
        "uplink_raw_bytes": ("cloud_ws_uplink", "raw_bytes"),
        "uplink_wire_bytes": ("cloud_ws_uplink", "wire_bytes"),
        "uplink_compression_total_us": ("cloud_ws_uplink", "compression_total_us"),
        "uplink_send_calls": ("cloud_ws_uplink", "send_calls"),
        "uplink_send_total_us": ("cloud_ws_uplink", "send_total_us"),
        "uplink_downlink_frames": ("cloud_ws_uplink", "downlink_frames"),
        "uplink_downlink_bytes": ("cloud_ws_uplink", "downlink_bytes"),
        "uplink_downlink_failures": ("cloud_ws_uplink", "downlink_failures"),
    }
    return {
        name: max(0, nested_int(after, *path) - nested_int(before, *path))
        for name, path in fields.items()
    }


def status_timeline_point(status: dict[str, Any], at_seconds: float) -> dict[str, Any]:
    return {
        "at_seconds": round(at_seconds, 3),
        "uptime_ms": nested_int(status, "uptime_ms"),
        "uart_rx_frames": nested_int(status, "comm_stats", "uart", "rx_frames"),
        "uart_rx_bytes": nested_int(status, "comm_stats", "uart", "rx_bytes"),
        "uart_tx_bytes": nested_int(status, "comm_stats", "uart", "tx_bytes"),
        "uart_tx_failures": nested_int(status, "comm_stats", "uart", "tx_failures"),
        "uart_overflows": nested_int(status, "comm_stats", "uart", "overflows"),
        "uplink_downlink_frames": nested_int(status, "cloud_ws_uplink", "downlink_frames"),
        "uplink_downlink_bytes": nested_int(status, "cloud_ws_uplink", "downlink_bytes"),
        "uplink_downlink_failures": nested_int(status, "cloud_ws_uplink", "downlink_failures"),
        "uplink_queued_frames": nested_int(status, "cloud_ws_uplink", "queued_frames"),
        "uplink_queued_bytes": nested_int(status, "cloud_ws_uplink", "queued_bytes"),
        "uplink_sent_frames": nested_int(status, "cloud_ws_uplink", "sent_frames"),
        "uplink_sent_bytes": nested_int(status, "cloud_ws_uplink", "sent_bytes"),
        "uplink_queue_pending_frames": nested_int(
            status, "cloud_ws_uplink", "queue_pending_frames"),
        "uplink_queue_pending_bytes": nested_int(
            status, "cloud_ws_uplink", "queue_pending_bytes"),
        "uplink_send_calls": nested_int(status, "cloud_ws_uplink", "send_calls"),
        "uplink_send_total_us": nested_int(status, "cloud_ws_uplink", "send_total_us"),
        "uplink_queue_dequeue_age_max_us": nested_int(
            status, "cloud_ws_uplink", "queue_dequeue_age_max_us"),
        "uplink_queue_batch_ready_age_max_us": nested_int(
            status, "cloud_ws_uplink", "queue_batch_ready_age_max_us"),
        "uplink_queue_send_start_age_max_us": nested_int(
            status, "cloud_ws_uplink", "queue_send_start_age_max_us"),
        "uplink_queue_drop_age_max_us": nested_int(
            status, "cloud_ws_uplink", "queue_drop_age_max_us"),
        "uplink_batch_wait_max_us": nested_int(
            status, "cloud_ws_uplink", "batch_wait_max_us"),
        "uplink_compression_max_us": nested_int(
            status, "cloud_ws_uplink", "compression_max_us"),
        "uplink_send_max_us": nested_int(
            status, "cloud_ws_uplink", "send_max_us"),
        "uplink_ws_data_lock_wait_max_us": nested_int(
            status, "cloud_ws_uplink", "ws_data_lock_wait_max_us"),
        "uplink_ws_data_lock_timeouts": nested_int(
            status, "cloud_ws_uplink", "ws_data_lock_timeouts"),
        "uplink_ws_transport_send_max_us": nested_int(
            status, "cloud_ws_uplink", "ws_transport_send_max_us"),
        "uplink_ws_ping_lock_wait_max_us": nested_int(
            status, "cloud_ws_uplink", "ws_ping_lock_wait_max_us"),
        "uplink_ws_ping_lock_timeouts": nested_int(
            status, "cloud_ws_uplink", "ws_ping_lock_timeouts"),
        "uplink_ws_ping_send_max_us": nested_int(
            status, "cloud_ws_uplink", "ws_ping_send_max_us"),
        "keepalive_active": bool(
            (status.get("cloud_osc_keepalive") or {}).get("active")),
        "keepalive_sent": nested_int(
            status, "cloud_osc_keepalive", "sent"),
        "keepalive_failures": nested_int(
            status, "cloud_osc_keepalive", "failures"),
        "keepalive_expirations": nested_int(
            status, "cloud_osc_keepalive", "expirations"),
        "keepalive_lease_remaining_ms": nested_int(
            status, "cloud_osc_keepalive", "lease_remaining_ms"),
        "keepalive_heartbeat_due_ms": nested_int(
            status, "cloud_osc_keepalive", "heartbeat_due_ms"),
    }


async def sample_status_timeline(
    fetch_status: Callable[[], dict[str, Any]],
    stop_event: asyncio.Event,
    *,
    sample_interval: float,
    started_at: float | None = None,
) -> list[dict[str, Any]]:
    if sample_interval <= 0:
        return []
    started = time.monotonic() if started_at is None else started_at
    timeline: list[dict[str, Any]] = []
    while not stop_event.is_set():
        cycle_started = time.monotonic()
        try:
            status = await asyncio.to_thread(fetch_status)
            completed_at = time.monotonic()
            point = status_timeline_point(status, completed_at - started)
            point["fetch_started_at_seconds"] = round(cycle_started - started, 3)
            point["fetch_duration_ms"] = round((completed_at - cycle_started) * 1000, 2)
            timeline.append(point)
        except (RuntimeError, urllib.error.URLError, TimeoutError, OSError) as exc:
            timeline.append({
                "at_seconds": round(time.monotonic() - started, 3),
                "fetch_started_at_seconds": round(cycle_started - started, 3),
                "fetch_duration_ms": round((time.monotonic() - cycle_started) * 1000, 2),
                "error": str(exc),
            })
        remaining = sample_interval - (time.monotonic() - cycle_started)
        if remaining <= 0:
            await asyncio.sleep(0)
            continue
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=remaining)
        except asyncio.TimeoutError:
            pass
    return timeline


def cloud_health_timeline_point(
    health: dict[str, Any], at_seconds: float
) -> dict[str, Any]:
    codec = health.get("waveform_codec") or {}
    return {
        "at_seconds": round(at_seconds, 3),
        "ws_uplink_devices": nested_int(health, "ws_uplink_devices"),
        "ws_browser_clients": nested_int(health, "ws_browser_clients"),
        "ws_downlink_sent_frames": nested_int(health, "ws_downlink_sent_frames"),
        "ws_downlink_sent_bytes": nested_int(health, "ws_downlink_sent_bytes"),
        "ws_downlink_dropped_frames": nested_int(health, "ws_downlink_dropped_frames"),
        "ws_downlink_send_failures": nested_int(health, "ws_downlink_send_failures"),
        "waveform_decoded_raw_bytes": nested_int(codec, "decoded_raw_bytes"),
        "waveform_compressed_messages": nested_int(codec, "compressed_messages"),
        "waveform_raw_envelope_messages": nested_int(codec, "raw_envelope_messages"),
        "waveform_legacy_raw_messages": nested_int(codec, "legacy_raw_messages"),
    }


async def sample_cloud_health_timeline(
    fetch_health: Callable[[], dict[str, Any]],
    stop_event: asyncio.Event,
    *,
    sample_interval: float,
    started_at: float | None = None,
) -> list[dict[str, Any]]:
    if sample_interval <= 0:
        return []
    started = time.monotonic() if started_at is None else started_at
    timeline: list[dict[str, Any]] = []
    while not stop_event.is_set():
        cycle_started = time.monotonic()
        try:
            health = await asyncio.to_thread(fetch_health)
            completed_at = time.monotonic()
            point = cloud_health_timeline_point(health, completed_at - started)
            point["fetch_started_at_seconds"] = round(cycle_started - started, 3)
            point["fetch_duration_ms"] = round((completed_at - cycle_started) * 1000, 2)
            timeline.append(point)
        except (RuntimeError, urllib.error.URLError, TimeoutError, OSError) as exc:
            timeline.append({
                "at_seconds": round(time.monotonic() - started, 3),
                "fetch_started_at_seconds": round(cycle_started - started, 3),
                "fetch_duration_ms": round((time.monotonic() - cycle_started) * 1000, 2),
                "error": str(exc),
            })
        remaining = sample_interval - (time.monotonic() - cycle_started)
        if remaining <= 0:
            await asyncio.sleep(0)
            continue
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=remaining)
        except asyncio.TimeoutError:
            pass
    return timeline


def ensure_current_firmware(status: dict[str, Any]) -> None:
    if nested_int(status, "cloud_ws_uplink", "schema_version") < 7:
        raise RuntimeError("latest firmware with cloud WebSocket uplink schema 7 is required")


def percentile(values: list[float], ratio: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, math.floor(len(ordered) * ratio))
    return ordered[index]


def frame_metrics(frames: list[tuple[float, int]], duration: float) -> dict[str, Any]:
    intervals = [
        (frames[index][0] - frames[index - 1][0]) * 1000
        for index in range(1, len(frames))
    ]
    total_bytes = sum(size for _, size in frames)
    return {
        "frames": len(frames),
        "bytes": total_bytes,
        "bytes_per_second": round(total_bytes / duration) if duration > 0 else 0,
        "interval_ms": {
            "mean": round(sum(intervals) / len(intervals), 2) if intervals else 0.0,
            "median": round(percentile(intervals, 0.50), 2),
            "p95": round(percentile(intervals, 0.95), 2),
            "max": round(max(intervals), 2) if intervals else 0.0,
        },
        "gaps_over_50_ms": sum(value > 50 for value in intervals),
        "gaps_over_100_ms": sum(value > 100 for value in intervals),
        "gaps_over_250_ms": sum(value > 250 for value in intervals),
    }


def osc_stream_integrity(
    raw: bytes,
    *,
    frame_len: int = 250,
    channel_count: int = 4,
    channel_index: int = 0,
) -> dict[str, Any]:
    """Scan a browser byte stream and verify one int16 channel sample by sample."""
    if frame_len < 10:
        raise ValueError("frame_len must include the 10-byte osc frame overhead")
    if channel_count <= 0 or not 0 <= channel_index < channel_count:
        raise ValueError("channel_index must select an available channel")

    stride = channel_count * 2
    payload_len = frame_len - 10
    if payload_len % stride != 0:
        raise ValueError("osc payload length must contain complete int16 sample rows")

    logical_frames = 0
    header_anchored_frames = 0
    footer_anchored_frames = 0
    dual_anchored_frames = 0
    invalid_crc_candidates = 0
    samples = 0
    discontinuity_count = 0
    previous: int | None = None
    first_value: int | None = None
    last_value: int | None = None
    discontinuities: list[dict[str, int]] = []
    implied_missing_samples = 0
    offset = 0

    while offset + frame_len <= len(raw):
        frame = raw[offset:offset + frame_len]
        header_valid = frame[:4] == OSC_HEADER
        footer_valid = frame[-4:] == OSC_HEADER
        if not header_valid and not footer_valid:
            offset += 1
            continue

        payload = frame[4:-6]
        expected_crc = crc16(payload)
        actual_crc = frame[-6] | (frame[-5] << 8)
        if actual_crc != expected_crc:
            invalid_crc_candidates += 1
            offset += 1
            continue

        logical_frames += 1
        if header_valid and footer_valid:
            dual_anchored_frames += 1
        elif header_valid:
            header_anchored_frames += 1
        else:
            footer_anchored_frames += 1

        frame_samples = payload_len // stride
        for sample_offset in range(frame_samples):
            value_offset = sample_offset * stride + channel_index * 2
            value = int.from_bytes(
                payload[value_offset:value_offset + 2], "big", signed=True)
            if first_value is None:
                first_value = value
            if previous is not None:
                modulo_step = ((value & 0xFFFF) - (previous & 0xFFFF)) & 0xFFFF
                if modulo_step != 1:
                    discontinuity_count += 1
                    missing = (modulo_step - 1) & 0xFFFF
                    implied_missing_samples += missing
                    if len(discontinuities) < 100:
                        discontinuities.append({
                            "sample_index": samples,
                            "previous": previous,
                            "actual": value,
                            "modulo_step": modulo_step,
                            "implied_missing_samples": missing,
                            "stream_offset": offset,
                        })
            previous = value
            last_value = value
            samples += 1

        offset += frame_len

    return {
        "raw_bytes": len(raw),
        "logical_frames": logical_frames,
        "header_anchored_frames": header_anchored_frames,
        "footer_anchored_frames": footer_anchored_frames,
        "dual_anchored_frames": dual_anchored_frames,
        "invalid_crc_candidates": invalid_crc_candidates,
        "discarded_bytes": len(raw) - logical_frames * frame_len,
        "samples": samples,
        "checked_transitions": max(0, samples - 1),
        "first_value": first_value,
        "last_value": last_value,
        "discontinuity_count": discontinuity_count,
        "implied_missing_samples": implied_missing_samples,
        "first_discontinuities": discontinuities,
    }


def write_raw_capture(raw: bytes, output_path: Path) -> dict[str, Any]:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(output_path, "wb") as output:
        output.write(raw)
    return {
        "path": str(output_path),
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


def heartbeat_metrics(latencies_ms: list[float]) -> dict[str, Any]:
    return {
        "count": len(latencies_ms),
        "p95_ms": round(percentile(latencies_ms, 0.95), 2),
        "max_ms": round(max(latencies_ms), 2) if latencies_ms else 0.0,
    }


def cloud_health_deltas(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    before_codec = before.get("waveform_codec") or {}
    after_codec = after.get("waveform_codec") or {}
    fields = (
        "wire_bytes",
        "decoded_raw_bytes",
        "activations",
        "compressed_messages",
        "raw_envelope_messages",
        "legacy_raw_messages",
        "decode_total_us",
    )
    codec = {
        field: max(0, nested_int(after_codec, field) - nested_int(before_codec, field))
        for field in fields
    }
    before_failures = before_codec.get("decode_failures") or {}
    after_failures = after_codec.get("decode_failures") or {}
    codec["decode_failures"] = max(
        0,
        sum(int(value or 0) for value in after_failures.values()) -
        sum(int(value or 0) for value in before_failures.values()),
    )
    codec["decode_max_us"] = nested_int(after_codec, "decode_max_us")
    return {
        "browser_drop_delta": max(
            0,
            nested_int(after, "ws_browser_dropped_frames") -
            nested_int(before, "ws_browser_dropped_frames"),
        ),
        "codec": codec,
    }


def compression_checks(
    deltas: dict[str, int],
    uplink_after: dict[str, Any],
    cloud_codec: dict[str, Any],
    heartbeat: dict[str, Any],
    *,
    browser_drop_delta: int,
    internal_min_free_heap: int,
) -> dict[str, bool]:
    raw_bytes = deltas.get("uplink_raw_bytes", 0)
    wire_bytes = deltas.get("uplink_wire_bytes", 0)
    calls = deltas.get("uplink_compression_calls", 0)
    compression_total_us = deltas.get("uplink_compression_total_us", 0)
    decoded_messages = (
        int(cloud_codec.get("compressed_messages") or 0) +
        int(cloud_codec.get("raw_envelope_messages") or 0)
    )
    decode_total_us = int(cloud_codec.get("decode_total_us") or 0)
    return {
        "compression_negotiated": (
            bool(uplink_after.get("compression_capable")) and
            bool(uplink_after.get("compression_active"))
        ),
        "compression_calls_observed": calls > 0,
        "compression_frames_accounted": (
            deltas.get("uplink_compressed_frames", 0) +
            deltas.get("uplink_raw_envelope_frames", 0) == calls
        ),
        "compression_no_failures": deltas.get("uplink_compression_failures", 0) == 0,
        "wire_ratio_below_20_percent": raw_bytes > 0 and wire_bytes / raw_bytes < 0.20,
        "compression_average_us": calls > 0 and compression_total_us / calls <= 5000,
        "compression_max_us": int(uplink_after.get("compression_max_us") or 0) <= 10000,
        "cloud_decode_messages": decoded_messages > 0,
        "cloud_decode_average_us": (
            decoded_messages > 0 and decode_total_us / decoded_messages <= 1000
        ),
        "cloud_decode_no_failure": int(cloud_codec.get("decode_failures") or 0) == 0,
        "browser_pump_no_drop": browser_drop_delta == 0,
        "heartbeat_observed": int(heartbeat.get("count") or 0) > 0,
        "heartbeat_p95_ms": float(heartbeat.get("p95_ms") or 0) <= 500,
        "heartbeat_max_ms": float(heartbeat.get("max_ms") or 0) < 2000,
        "internal_min_free_heap": internal_min_free_heap >= 8192,
    }


def latest_remote_ws_seq(payload: dict[str, Any]) -> int:
    return max((nested_int(frame, "seq") for frame in payload.get("frames") or []), default=0)


def count_remote_waveform_frames(payload: dict[str, Any]) -> int:
    count = 0
    for frame in payload.get("frames") or []:
        payload_hex = str(frame.get("payload_hex") or "")
        if len(payload_hex) >= 64:
            count += 1
    return count


def evaluate_result(mode: str, metrics: dict[str, Any], deltas: dict[str, int],
                    fallback_requested: bool, min_bytes_per_second: int,
                    max_p95_ms: float, max_gap_ms: float,
                    fallback_window_frames: int = 0,
                    mqtt_poll_frames: int = 0,
                    fallback_injection_completed: bool = False,
                    uplink_schema_version: int = 0,
                    uplink_after: dict[str, Any] | None = None,
                    cloud_codec: dict[str, Any] | None = None,
                    heartbeat: dict[str, Any] | None = None,
                    browser_drop_delta: int = 0,
                    internal_min_free_heap: int = 0) -> dict[str, Any]:
    intervals = metrics.get("interval_ms") or {}
    checks = {
        "received_waveform": metrics.get("frames", 0) > 0 and metrics.get("bytes", 0) > 0,
        "minimum_throughput": metrics.get("bytes_per_second", 0) >= min_bytes_per_second,
        "p95_latency": float(intervals.get("p95") or 0) <= max_p95_ms,
        "maximum_gap": float(intervals.get("max") or 0) <= max_gap_ms,
        "uart_no_overflow": deltas.get("uart_overflows", 0) == 0,
    }
    if mode == "local":
        checks.update({
            "wifi_pool_not_exhausted": deltas.get("wifi_pool_exhausted", 0) == 0,
            "wifi_queue_not_full": deltas.get("wifi_queue_full", 0) == 0,
            "route_no_partial_drop": deltas.get("route_partial_drops", 0) == 0,
        })
    else:
        checks.update({
            "uplink_schema_current": uplink_schema_version >= 7,
            "binary_uplink_queued": deltas.get("uplink_queued_frames", 0) > 0,
            "binary_uplink_queued_bytes": deltas.get("uplink_queued_bytes", 0) > 0,
            "binary_uplink_sent": deltas.get("uplink_sent_frames", 0) > 0,
            "binary_uplink_bytes": deltas.get("uplink_sent_bytes", 0) > 0,
            "uplink_overload_accounted": (
                deltas.get("uplink_queue_full", 0) >=
                deltas.get("uplink_overload_dropped_frames", 0)),
            "uplink_frames_accounted": (
                deltas.get("uplink_sent_frames", 0) +
                deltas.get("uplink_queued_fallback_frames", 0) +
                deltas.get("uplink_overload_dropped_frames", 0) +
                deltas.get("uplink_stop_dropped_frames", 0) +
                deltas.get("uplink_queue_pending_frames", 0) ==
                deltas.get("uplink_queued_frames", 0)),
            "uplink_bytes_accounted": (
                deltas.get("uplink_sent_bytes", 0) +
                deltas.get("uplink_queued_fallback_bytes", 0) +
                deltas.get("uplink_overload_dropped_bytes", 0) +
                deltas.get("uplink_stop_dropped_bytes", 0) +
                deltas.get("uplink_queue_pending_bytes", 0) ==
                deltas.get("uplink_queued_bytes", 0)),
            "uplink_no_ingress_rejection": (
                deltas.get("uplink_rejected_frames", 0) == 0 and
                deltas.get("uplink_rejected_bytes", 0) == 0),
            "mqtt_fallback_no_failures": deltas.get("uplink_fallback_failures", 0) == 0,
        })
        checks.update(compression_checks(
            deltas,
            uplink_after or {},
            cloud_codec or {},
            heartbeat or {},
            browser_drop_delta=browser_drop_delta,
            internal_min_free_heap=internal_min_free_heap,
        ))
        if not fallback_requested:
            checks.update({
                "uplink_queue_not_full": deltas.get("uplink_queue_full", 0) == 0,
                "uplink_no_overload_eviction": (
                    deltas.get("uplink_overload_dropped_frames", 0) == 0),
                "uplink_no_send_failure": deltas.get("uplink_send_failures", 0) == 0,
            })
        if fallback_requested:
            checks["fallback_injection_completed"] = fallback_injection_completed
            checks["mqtt_fallback_observed"] = deltas.get("uplink_fallback_frames", 0) > 0
            checks["mqtt_fallback_reached_browser"] = fallback_window_frames > 0
            checks["mqtt_fallback_recorded_by_cloud"] = mqtt_poll_frames > 0
    return {"passed": all(checks.values()), "checks": checks}


class HttpClient:
    def __init__(self, username: str = "", password: str = "",
                 use_proxy: bool = False) -> None:
        self.proxy_handler = urllib.request.ProxyHandler(None if use_proxy else {})
        self.opener = urllib.request.build_opener(self.proxy_handler)
        self.authorization = ""
        if username or password:
            token = base64.b64encode(f"{username}:{password}".encode()).decode()
            self.authorization = f"Basic {token}"

    def json(self, url: str, method: str = "GET", body: Any = None,
             timeout: float = 8.0) -> dict[str, Any]:
        data = None if body is None else json.dumps(body).encode()
        headers = {"Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if self.authorization:
            headers["Authorization"] = self.authorization
        attempts = 3 if method == "GET" and body is None else 1
        for attempt in range(attempts):
            request = urllib.request.Request(url, data=data, method=method, headers=headers)
            try:
                with self.opener.open(request, timeout=timeout) as response:
                    return json.loads(response.read().decode())
            except (http.client.IncompleteRead, urllib.error.URLError, TimeoutError):
                if attempt + 1 >= attempts:
                    raise
                time.sleep(0.25 * (attempt + 1))
        raise RuntimeError("unreachable HTTP retry state")


def cloud_device_status(http: HttpClient, cloud_http: str, device_id: str) -> dict[str, Any]:
    detail = http.json(f"{cloud_http.rstrip('/')}/api/devices/{urllib.parse.quote(device_id)}")
    device = detail.get("device") or {}
    return device.get("last_status_json") or {}


def refresh_cloud_status(http: HttpClient, cloud_http: str, device_id: str,
                         previous_uptime: int = -1, timeout: float = 12.0) -> dict[str, Any]:
    base = cloud_http.rstrip("/")
    http.json(f"{base}/api/devices/{urllib.parse.quote(device_id)}/query-status", method="POST", body={})
    deadline = time.monotonic() + timeout
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        last = cloud_device_status(http, base, device_id)
        uptime = nested_int(last, "uptime_ms")
        if last and (previous_uptime < 0 or uptime != previous_uptime):
            return last
        time.sleep(0.5)
    raise RuntimeError("cloud status did not refresh")


async def run_stream(ws: Any, duration: float, inject_fallback: bool,
                     uplink_url: str | None, connect: Any,
                     mark_fallback_window: Any = None,
                     capture_fallback_window: Any = None,
                     use_proxy: bool = False,
                     raw_sink: bytearray | None = None,
                     comm_rate_limit: int = 0,
                     heartbeat_interval: float = 1.0,
                     timeline_origin: float | None = None,
                     ) -> tuple[list[tuple[float, int]], dict[str, Any]]:
    if heartbeat_interval <= 0:
        raise ValueError("heartbeat_interval must be positive")
    origin = time.monotonic() if timeline_origin is None else timeline_origin
    frames: list[tuple[float, int]] = []
    heartbeat_sent_at: deque[tuple[float, dict[str, Any]]] = deque()
    heartbeat_latencies_ms: list[float] = []
    heartbeat_carry = b""
    control_timeline: list[dict[str, Any]] = []
    receive_timeline: list[dict[str, Any]] = []
    control_sequence = 0
    capture = False
    stop_receiver = asyncio.Event()
    injection = {"requested": inject_fallback, "completed": False, "at_seconds": None}
    fallback_window_start: float | None = None
    stream_started_at: float | None = None
    stream_ended_at: float | None = None

    async def send_control(
        label: str,
        payload: bytes,
        *,
        scheduled_at: float | None = None,
    ) -> dict[str, Any]:
        nonlocal control_sequence
        control_sequence += 1
        send_started = time.monotonic()
        event: dict[str, Any] = {
            "sequence": control_sequence,
            "label": label,
            "bytes": len(payload),
            "send_started_at_seconds": round(send_started - origin, 6),
        }
        if scheduled_at is not None:
            event["scheduled_at_seconds"] = round(scheduled_at - origin, 6)
            event["schedule_lag_ms"] = round(
                max(0.0, send_started - scheduled_at) * 1000, 3)
        control_timeline.append(event)
        if label == "heartbeat":
            heartbeat_sent_at.append((send_started, event))
        try:
            await ws.send(payload)
        except Exception as exc:
            send_completed = time.monotonic()
            event["send_completed_at_seconds"] = round(send_completed - origin, 6)
            event["send_duration_ms"] = round((send_completed - send_started) * 1000, 3)
            event["status"] = "failed"
            event["error_type"] = type(exc).__name__
            if (label == "heartbeat" and heartbeat_sent_at and
                    heartbeat_sent_at[-1][1] is event):
                heartbeat_sent_at.pop()
            raise
        send_completed = time.monotonic()
        event["send_completed_at_seconds"] = round(send_completed - origin, 6)
        event["send_duration_ms"] = round((send_completed - send_started) * 1000, 3)
        event["status"] = "sent"
        return event

    async def receiver() -> None:
        nonlocal capture, heartbeat_carry
        while not stop_receiver.is_set():
            try:
                message = await asyncio.wait_for(ws.recv(), timeout=0.5)
            except asyncio.TimeoutError:
                continue
            except Exception:
                return
            if not capture:
                continue
            data = message.encode("latin1") if isinstance(message, str) else bytes(message)
            if data:
                received_at = time.monotonic()
                if raw_sink is not None:
                    raw_sink.extend(data)
                scan = heartbeat_carry + data
                offset = 0
                heartbeat_matches = 0
                while True:
                    match = scan.find(HEARTBEAT_FRAME, offset)
                    if match < 0:
                        break
                    if heartbeat_sent_at:
                        sent_at, heartbeat_event = heartbeat_sent_at.popleft()
                        latency_ms = (received_at - sent_at) * 1000
                        heartbeat_latencies_ms.append(latency_ms)
                        heartbeat_event["response_at_seconds"] = round(
                            received_at - origin, 6)
                        heartbeat_event["round_trip_ms"] = round(latency_ms, 3)
                        scheduled = heartbeat_event.get("scheduled_at_seconds")
                        if scheduled is not None:
                            heartbeat_event["scheduled_to_response_ms"] = round(
                                (received_at - origin - float(scheduled)) * 1000, 3)
                    heartbeat_matches += 1
                    offset = match + len(HEARTBEAT_FRAME)
                heartbeat_carry = scan[-(len(HEARTBEAT_FRAME) - 1):]
                frames.append((received_at, len(data)))
                receive_timeline.append({
                    "at_seconds": round(received_at - origin, 6),
                    "bytes": len(data),
                    "heartbeat_matches": heartbeat_matches,
                })

    receiver_task = asyncio.create_task(receiver())
    try:
        await send_control("stop_before_start", STOP_FRAME)
        await asyncio.sleep(0.25)
        for channel, (param_type, address) in enumerate(OSC_CHANNEL_CONFIG, start=1):
            await send_control(
                f"set_channel_{channel}",
                set_channel_frame(channel, param_type, address),
            )
            await asyncio.sleep(0.08)
        if comm_rate_limit > 0:
            await send_control("set_rate", set_rate_frame(comm_rate_limit))
            await asyncio.sleep(0.08)
        await send_control("start", START_FRAME)
        await asyncio.sleep(1.0)
        capture = True
        started = time.monotonic()
        stream_started_at = started
        next_heartbeat = started
        inject_at = started + max(2.0, duration / 2)
        injected = False
        while time.monotonic() - started < duration:
            now = time.monotonic()
            if now >= next_heartbeat:
                await send_control(
                    "heartbeat", HEARTBEAT_FRAME, scheduled_at=next_heartbeat)
                next_heartbeat = now + heartbeat_interval
            if inject_fallback and not injected and now >= inject_at and uplink_url:
                injected = True
                injection["at_seconds"] = round(now - started, 2)
                if mark_fallback_window is not None:
                    injection["cloud_poll_after_seq"] = await mark_fallback_window()
                replacement = await connect(
                    uplink_url, **{**websocket_connect_options(use_proxy),
                                   "open_timeout": 5, "close_timeout": 2})
                await asyncio.sleep(0.35)
                await replacement.close()
                injection["completed"] = True
                if capture_fallback_window is not None:
                    await asyncio.sleep(0.35)
                    injection["cloud_poll_frames"] = await capture_fallback_window(
                        int(injection.get("cloud_poll_after_seq") or 0))
                fallback_window_start = time.monotonic()
            await asyncio.sleep(0.03)
    finally:
        stream_ended_at = time.monotonic()
        capture = False
        try:
            await send_control("stop_after_stream", STOP_FRAME)
        except Exception:
            pass
        await asyncio.sleep(0.25)
        stop_receiver.set()
        await receiver_task
    if fallback_window_start is not None:
        window_end = fallback_window_start + 1.2
        window_frames = [frame for frame in frames if fallback_window_start <= frame[0] <= window_end]
        injection["browser_frames"] = len(window_frames)
        injection["browser_waveform_frames"] = sum(size >= 32 for _, size in window_frames)
        injection["browser_bytes"] = sum(size for _, size in window_frames)
    else:
        injection["browser_frames"] = 0
        injection["browser_waveform_frames"] = 0
        injection["browser_bytes"] = 0
    heartbeat = heartbeat_metrics(heartbeat_latencies_ms)
    heartbeat_events = [
        event for event in control_timeline if event.get("label") == "heartbeat"
    ]
    heartbeat.update({
        "sent": len(heartbeat_events),
        "responses": sum("response_at_seconds" in event for event in heartbeat_events),
        "unmatched": sum("response_at_seconds" not in event for event in heartbeat_events),
        "schedule_lag_max_ms": round(max(
            (float(event.get("schedule_lag_ms") or 0) for event in heartbeat_events),
            default=0.0,
        ), 3),
        "send_duration_max_ms": round(max(
            (float(event.get("send_duration_ms") or 0) for event in heartbeat_events),
            default=0.0,
        ), 3),
    })
    injection["heartbeat"] = heartbeat
    injection["transport_timeline"] = {
        "origin": "async_main_monotonic",
        "stream_started_at_seconds": (
            round(stream_started_at - origin, 6) if stream_started_at is not None else None),
        "stream_ended_at_seconds": (
            round(stream_ended_at - origin, 6) if stream_ended_at is not None else None),
        "heartbeat_interval_seconds": heartbeat_interval,
        "control_sends": control_timeline,
        "receives": receive_timeline,
    }
    return frames, injection


async def preclean_stream(ws_url: str, connect: Any, use_proxy: bool = False) -> None:
    async with connect(ws_url, **websocket_connect_options(use_proxy)) as ws:
        await ws.send(STOP_FRAME)
        await asyncio.sleep(1.0)


async def async_main(args: argparse.Namespace) -> dict[str, Any]:
    try:
        from websockets.asyncio.client import connect
    except ImportError as exc:
        raise RuntimeError("missing dependency: python -m pip install 'websockets>=14,<16'") from exc

    username = args.username or os.environ.get("CLOUD_HTTP_USER", "")
    password = args.password or os.environ.get("CLOUD_HTTP_PASSWORD", "")
    mode = args.mode
    use_proxy = mode == "cloud"
    http = HttpClient(username, password, use_proxy=use_proxy)
    fallback_requested = mode == "cloud" and args.inject_fallback
    cloud_health_before: dict[str, Any] = {}
    cloud_health_after: dict[str, Any] = {}
    raw_stream = bytearray()
    status_timeline: list[dict[str, Any]] = []
    cloud_health_timeline: list[dict[str, Any]] = []

    if mode == "local":
        api_base = args.local_http.rstrip("/")
        ws_url = args.local_ws
        current = http.json(f"{api_base}/api/device/status")
        ensure_current_firmware(current)
        await preclean_stream(ws_url, connect, use_proxy=use_proxy)
        before = http.json(f"{api_base}/api/device/status")
        uplink_url = None
    else:
        if not args.device_id:
            raise RuntimeError("--device-id is required in cloud mode")
        stale = cloud_device_status(http, args.cloud_http, args.device_id)
        current = refresh_cloud_status(
            http, args.cloud_http, args.device_id,
            previous_uptime=nested_int(stale, "uptime_ms"), timeout=15.0)
        ensure_current_firmware(current)
        ws_url = args.cloud_ws.rstrip("/") + f"/ws/device/{urllib.parse.quote(args.device_id)}"
        await preclean_stream(ws_url, connect, use_proxy=use_proxy)
        before = refresh_cloud_status(
            http, args.cloud_http, args.device_id,
            previous_uptime=nested_int(current, "uptime_ms"), timeout=15.0)
        uplink_url = args.cloud_ws.rstrip("/") + f"/ws/uplink/{urllib.parse.quote(args.device_id)}"
        remote_poll_url = (
            args.cloud_http.rstrip("/") +
            f"/remote/{urllib.parse.quote(args.device_id)}/ws/poll")
        initial_poll = http.json(remote_poll_url)
        initial_poll_seq = latest_remote_ws_seq(initial_poll)
        cloud_health_before = http.json(f"{args.cloud_http.rstrip('/')}/health")

    started = time.monotonic()
    timeline_stop: asyncio.Event | None = None
    status_timeline_task: asyncio.Task[list[dict[str, Any]]] | None = None
    health_timeline_task: asyncio.Task[list[dict[str, Any]]] | None = None
    if mode == "cloud" and (
        args.status_sample_interval > 0 or args.health_sample_interval > 0
    ):
        timeline_stop = asyncio.Event()
    if mode == "cloud" and args.status_sample_interval > 0:
        timeline_http = HttpClient(username, password, use_proxy=use_proxy)
        timeline_previous_uptime = nested_int(before, "uptime_ms")

        def fetch_timeline_status() -> dict[str, Any]:
            nonlocal timeline_previous_uptime
            status = refresh_cloud_status(
                timeline_http,
                args.cloud_http,
                args.device_id,
                previous_uptime=timeline_previous_uptime,
                timeout=max(3.0, min(10.0, args.status_sample_interval * 4)),
            )
            timeline_previous_uptime = nested_int(status, "uptime_ms")
            return status

        status_timeline_task = asyncio.create_task(sample_status_timeline(
            fetch_timeline_status,
            timeline_stop,
            sample_interval=args.status_sample_interval,
            started_at=started,
        ))
    if mode == "cloud" and args.health_sample_interval > 0:
        health_timeline_http = HttpClient(username, password, use_proxy=use_proxy)

        def fetch_timeline_health() -> dict[str, Any]:
            return health_timeline_http.json(
                f"{args.cloud_http.rstrip('/')}/health", timeout=5.0)

        health_timeline_task = asyncio.create_task(sample_cloud_health_timeline(
            fetch_timeline_health,
            timeline_stop,
            sample_interval=args.health_sample_interval,
            started_at=started,
        ))

    async def mark_fallback_window() -> int:
        if mode != "cloud":
            return 0
        return latest_remote_ws_seq(http.json(remote_poll_url))

    async def capture_fallback_window(after_seq: int) -> int:
        if mode != "cloud":
            return 0
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            count = count_remote_waveform_frames(
                http.json(f"{remote_poll_url}?after={after_seq}"))
            if count > 0:
                return count
            await asyncio.sleep(0.1)
        return 0

    try:
        async with connect(ws_url, **websocket_connect_options(use_proxy)) as ws:
            frames, injection = await run_stream(
                ws, args.duration, fallback_requested, uplink_url, connect,
                mark_fallback_window=mark_fallback_window,
                capture_fallback_window=capture_fallback_window,
                use_proxy=use_proxy,
                raw_sink=raw_stream,
                comm_rate_limit=args.comm_rate_limit,
                heartbeat_interval=args.heartbeat_interval,
                timeline_origin=started)
    finally:
        if timeline_stop is not None:
            timeline_stop.set()
        if status_timeline_task is not None:
            status_timeline = await status_timeline_task
        if health_timeline_task is not None:
            cloud_health_timeline = await health_timeline_task
        if mode == "local":
            http.json(f"{api_base}/api/comm/mode", method="POST", body={"mode": "auto"})
    elapsed = time.monotonic() - started

    if mode == "local":
        after = http.json(f"{api_base}/api/device/status")
    else:
        fallback_after_seq = int(injection.get("cloud_poll_after_seq") or initial_poll_seq)
        fallback_poll = http.json(f"{remote_poll_url}?after={fallback_after_seq}")
        await asyncio.sleep(2.5)
        after = refresh_cloud_status(
            http, args.cloud_http, args.device_id,
            previous_uptime=nested_int(before, "uptime_ms"), timeout=15.0)
        cloud_health_after = http.json(f"{args.cloud_http.rstrip('/')}/health")

    metrics = frame_metrics(frames, args.duration)
    integrity = osc_stream_integrity(
        bytes(raw_stream),
        frame_len=args.frame_len,
        channel_count=args.channel_count,
        channel_index=args.channel_index,
    )
    raw_capture = (
        write_raw_capture(bytes(raw_stream), args.raw_output)
        if args.raw_output is not None
        else {
            "path": None,
            "bytes": len(raw_stream),
            "sha256": hashlib.sha256(raw_stream).hexdigest(),
        }
    )
    deltas = status_deltas(before, after)
    health_deltas = cloud_health_deltas(cloud_health_before, cloud_health_after)
    verdict = evaluate_result(
        mode, metrics, deltas, fallback_requested,
        args.min_bytes_per_second,
        args.max_p95_ms if args.max_p95_ms is not None else (50.0 if mode == "local" else 100.0),
        args.max_gap_ms,
        int(injection.get("browser_waveform_frames") or 0),
        (int(injection.get("cloud_poll_frames") or 0)
         if mode == "cloud" and fallback_requested
         else count_remote_waveform_frames(fallback_poll) if mode == "cloud" else 0),
        bool(injection.get("completed")),
        nested_int(after, "cloud_ws_uplink", "schema_version") if mode == "cloud" else 0,
        uplink_after=after.get("cloud_ws_uplink") or {},
        cloud_codec=health_deltas.get("codec") or {},
        heartbeat=injection.get("heartbeat") or {},
        browser_drop_delta=int(health_deltas.get("browser_drop_delta") or 0),
        internal_min_free_heap=nested_int(after, "heap", "internal_min_free"),
    )
    if mode == "cloud":
        verdict["checks"]["queue_in_psram"] = bool((after.get("cloud_ws_uplink") or {}).get("queue_in_psram"))
        verdict["passed"] = all(verdict["checks"].values())

    return {
        "mode": mode,
        "target": ws_url,
        "device_id": args.device_id if mode == "cloud" else None,
        "requested_duration_seconds": args.duration,
        "wall_time_seconds": round(elapsed, 2),
        "metrics": metrics,
        "stream_integrity": integrity,
        "raw_capture": raw_capture,
        "counter_deltas": deltas,
        "status_timeline": status_timeline,
        "cloud_health_timeline": cloud_health_timeline,
        "transport_timeline": injection.get("transport_timeline"),
        "uart_after": (after.get("comm_stats") or {}).get("uart"),
        "fallback_injection": injection,
        "heartbeat": injection.get("heartbeat"),
        "cloud_health_deltas": health_deltas if mode == "cloud" else None,
        "mqtt_fallback_cloud_frames": (
            int(injection.get("cloud_poll_frames") or 0)
            if mode == "cloud" and fallback_requested
            else count_remote_waveform_frames(fallback_poll) if mode == "cloud" else 0),
        "uplink_after": after.get("cloud_ws_uplink") if mode == "cloud" else None,
        "keepalive_after": after.get("cloud_osc_keepalive") if mode == "cloud" else None,
        "verdict": verdict,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("local", "cloud"), required=True)
    parser.add_argument("--duration", type=float, default=12.0)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--local-http", default="http://192.168.4.1")
    parser.add_argument("--local-ws", default="ws://192.168.4.1/ws")
    parser.add_argument("--cloud-http", default="http://43.153.137.20:18088")
    parser.add_argument("--cloud-ws", default="ws://43.153.137.20:18089")
    parser.add_argument("--device-id", default="")
    parser.add_argument("--username", default="")
    parser.add_argument("--password", default="")
    parser.add_argument("--inject-fallback", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--min-bytes-per-second", type=int, default=15000)
    parser.add_argument("--max-p95-ms", type=float)
    parser.add_argument("--max-gap-ms", type=float, default=750.0)
    parser.add_argument("--frame-len", type=int, default=250)
    parser.add_argument("--channel-count", type=int, default=4)
    parser.add_argument("--channel-index", type=int, default=0)
    parser.add_argument("--raw-output", type=Path)
    parser.add_argument("--comm-rate-limit", type=int, default=0)
    parser.add_argument("--status-sample-interval", type=float, default=0.0)
    parser.add_argument("--health-sample-interval", type=float, default=0.0)
    parser.add_argument("--heartbeat-interval", type=float, default=1.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.duration < 3:
        print("duration must be at least 3 seconds", file=sys.stderr)
        return 2
    if args.status_sample_interval < 0 or args.health_sample_interval < 0:
        print("timeline sample intervals must not be negative", file=sys.stderr)
        return 2
    if args.heartbeat_interval <= 0:
        print("heartbeat interval must be positive", file=sys.stderr)
        return 2
    try:
        result = asyncio.run(async_main(args))
    except (RuntimeError, urllib.error.URLError, TimeoutError, asyncio.TimeoutError, OSError) as exc:
        result = {"verdict": {"passed": False}, "error": str(exc)}
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    print(rendered)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    return 0 if result.get("verdict", {}).get("passed") else 1


if __name__ == "__main__":
    raise SystemExit(main())
