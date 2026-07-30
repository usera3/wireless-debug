#!/usr/bin/env python3
"""Correlate cloud oscilloscope heartbeat and waveform diagnostic timelines."""

import argparse
import json
import math
from pathlib import Path
from typing import Any


def numeric(value: Any) -> float:
    if isinstance(value, bool):
        return float(int(value))
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    return 0.0


def timeline_window(document: dict[str, Any]) -> tuple[float, float]:
    transport = document.get("transport_timeline") or {}
    start = numeric(transport.get("stream_started_at_seconds"))
    end = numeric(transport.get("stream_ended_at_seconds"))
    if end <= start:
        end = start + numeric(document.get("requested_duration_seconds"))
    return start, end


def valid_host_points(
    points: list[dict[str, Any]], start: float, end: float
) -> list[dict[str, Any]]:
    valid = [
        point for point in points
        if "error" not in point and start <= numeric(point.get("at_seconds")) <= end
    ]
    return sorted(valid, key=lambda point: numeric(point.get("at_seconds")))


def valid_status_points(
    points: list[dict[str, Any]], start: float, end: float
) -> list[dict[str, Any]]:
    filtered = valid_host_points(points, start, end)
    by_uptime: dict[int, dict[str, Any]] = {}
    for point in filtered:
        uptime = int(numeric(point.get("uptime_ms")))
        if uptime > 0:
            by_uptime[uptime] = point
    return [by_uptime[uptime] for uptime in sorted(by_uptime)]


def counter_stalls(
    points: list[dict[str, Any]],
    counter: str,
    *,
    time_key: str,
    time_scale: float = 1.0,
) -> dict[str, Any]:
    if len(points) < 2:
        return {"counter": counter, "samples": len(points), "max_seconds": 0.0,
                "intervals_over_threshold": []}
    ordered = sorted(points, key=lambda point: numeric(point.get(time_key)))
    gaps: list[dict[str, Any]] = []
    progress: list[dict[str, Any]] = []
    stagnant_start: float | None = None
    stagnant_end: float | None = None
    stagnant_value = 0.0
    for previous, point in zip(ordered, ordered[1:]):
        start = numeric(previous.get(time_key)) / time_scale
        end = numeric(point.get(time_key)) / time_scale
        previous_value = numeric(previous.get(counter))
        value = numeric(point.get(counter))
        if value == previous_value:
            if stagnant_start is None:
                stagnant_start = start
                stagnant_value = previous_value
            stagnant_end = end
            continue
        if stagnant_start is not None and stagnant_end is not None:
            gaps.append({
                "start": round(stagnant_start, 6),
                "end": round(stagnant_end, 6),
                "seconds": round(max(0.0, stagnant_end - stagnant_start), 6),
                "value": int(stagnant_value),
                "resume_observed_at": round(end, 6),
                "terminal": False,
            })
            stagnant_start = None
            stagnant_end = None
        delta = value - previous_value
        progress.append({
            "start": round(start, 6),
            "end": round(end, 6),
            "seconds": round(max(0.0, end - start), 6),
            "delta": int(delta),
            "seconds_per_increment": round((end - start) / delta, 6) if delta > 0 else None,
        })
    if stagnant_start is not None and stagnant_end is not None:
        gaps.append({
            "start": round(stagnant_start, 6),
            "end": round(stagnant_end, 6),
            "seconds": round(max(0.0, stagnant_end - stagnant_start), 6),
            "value": int(stagnant_value),
            "resume_observed_at": None,
            "terminal": True,
        })
    longest = max(gaps, key=lambda gap: gap["seconds"], default=None)
    return {
        "counter": counter,
        "samples": len(ordered),
        "max_seconds": numeric(longest.get("seconds")) if longest else 0.0,
        "longest": longest,
        "confirmed_no_progress_intervals": gaps,
        "progress_intervals": progress,
    }


def event_gap_summary(
    events: list[dict[str, Any]],
    *,
    time_key: str,
    start: float,
    end: float,
) -> dict[str, Any]:
    times = sorted(
        numeric(event.get(time_key)) for event in events
        if start <= numeric(event.get(time_key)) <= end
    )
    boundaries = [start, *times, end]
    gaps = [
        {
            "start": round(boundaries[index - 1], 6),
            "end": round(boundaries[index], 6),
            "seconds": round(boundaries[index] - boundaries[index - 1], 6),
        }
        for index in range(1, len(boundaries))
    ]
    longest = max(gaps, key=lambda gap: gap["seconds"], default=None)
    return {
        "events": len(times),
        "max_seconds": numeric(longest.get("seconds")) if longest else 0.0,
        "longest": longest,
    }


def heartbeat_summary(
    controls: list[dict[str, Any]], threshold_seconds: float,
    observation_end: float | None = None,
) -> dict[str, Any]:
    heartbeats = [event for event in controls if event.get("label") == "heartbeat"]
    heartbeats.sort(key=lambda event: numeric(event.get("sequence")))
    starts = [numeric(event.get("send_started_at_seconds")) for event in heartbeats]
    send_gaps = [
        (starts[index] - starts[index - 1]) * 1000
        for index in range(1, len(starts))
    ]
    bad = []
    censored = 0
    threshold_ms = threshold_seconds * 1000
    for event in heartbeats:
        reason = None
        if numeric(event.get("schedule_lag_ms")) >= threshold_ms:
            reason = "schedule_lag"
        elif numeric(event.get("send_duration_ms")) >= threshold_ms:
            reason = "send_duration"
        elif ("response_at_seconds" in event and
              numeric(event.get("round_trip_ms")) >= threshold_ms):
            reason = "round_trip"
        elif event.get("status") == "sent" and "response_at_seconds" not in event:
            sent_at = numeric(event.get("send_started_at_seconds"))
            if observation_end is not None and sent_at + threshold_seconds > observation_end:
                censored += 1
            else:
                reason = "no_response"
        if reason:
            bad.append({"sequence": event.get("sequence"), "reason": reason, **event})
    return {
        "sent": len(heartbeats),
        "responses": sum("response_at_seconds" in event for event in heartbeats),
        "unmatched": sum("response_at_seconds" not in event for event in heartbeats),
        "censored_unmatched": censored,
        "max_send_interval_ms": round(max(send_gaps), 3) if send_gaps else 0.0,
        "max_schedule_lag_ms": round(max(
            (numeric(event.get("schedule_lag_ms")) for event in heartbeats),
            default=0.0,
        ), 3),
        "max_send_duration_ms": round(max(
            (numeric(event.get("send_duration_ms")) for event in heartbeats),
            default=0.0,
        ), 3),
        "max_round_trip_ms": round(max(
            (numeric(event.get("round_trip_ms")) for event in heartbeats),
            default=0.0,
        ), 3),
        "first_threshold_breach": bad[0] if bad else None,
        "threshold_breaches": bad,
    }


def sample_quality(points: list[dict[str, Any]]) -> dict[str, Any]:
    errors = [point for point in points if "error" in point]
    durations = [
        numeric(point.get("fetch_duration_ms"))
        for point in points if "fetch_duration_ms" in point
    ]
    return {
        "samples": len(points),
        "errors": len(errors),
        "max_fetch_duration_ms": round(max(durations), 2) if durations else 0.0,
    }


def related_delta(
    points: list[dict[str, Any]], key: str, start: float, end: float, time_key: str
) -> int:
    selected = [
        point for point in points
        if start <= numeric(point.get(time_key)) <= end
    ]
    if len(selected) < 2:
        return 0
    return max(0, int(numeric(selected[-1].get(key)) - numeric(selected[0].get(key))))


def diagnose(stages: dict[str, dict[str, Any]], heartbeat: dict[str, Any],
             receive: dict[str, Any], threshold_seconds: float) -> dict[str, Any]:
    threshold_ms = threshold_seconds * 1000
    if heartbeat["max_schedule_lag_ms"] >= threshold_ms:
        stage = "client_scheduler"
    elif heartbeat["max_send_duration_ms"] >= threshold_ms:
        stage = "client_websocket_send"
    elif stages["cloud_downlink"]["max_seconds"] >= threshold_seconds:
        stage = "cloud_downlink_forwarding"
    elif stages["esp32_downlink"]["max_seconds"] >= threshold_seconds:
        stage = "cloud_to_esp32_downlink"
    elif stages["uart_tx"]["max_seconds"] >= threshold_seconds:
        stage = "esp32_downlink_to_uart"
    elif stages["uart_rx"]["max_seconds"] >= threshold_seconds:
        stage = "upstream_source_stopped"
    elif receive["max_seconds"] >= threshold_seconds:
        stage = "uart_to_browser_uplink"
    else:
        stage = "no_threshold_breach"
    return {
        "stage": stage,
        "threshold_seconds": threshold_seconds,
        "note": (
            "Stage is selected from observed counter stalls; inspect longest intervals and "
            "sampling latency before treating it as a production root cause."
        ),
    }


def analyze(document: dict[str, Any], threshold_seconds: float = 3.0) -> dict[str, Any]:
    if threshold_seconds <= 0:
        raise ValueError("threshold_seconds must be positive")
    start, end = timeline_window(document)
    transport = document.get("transport_timeline") or {}
    controls = transport.get("control_sends") or []
    receives = transport.get("receives") or []
    health_raw = document.get("cloud_health_timeline") or []
    status_raw = document.get("status_timeline") or []
    health = valid_host_points(health_raw, start, end)
    status = valid_status_points(status_raw, start, end)

    stages = {
        "cloud_downlink": counter_stalls(
            health, "ws_downlink_sent_frames", time_key="at_seconds"),
        "esp32_downlink": counter_stalls(
            status, "uplink_downlink_frames", time_key="uptime_ms", time_scale=1000),
        "uart_tx": counter_stalls(
            status, "uart_tx_bytes", time_key="uptime_ms", time_scale=1000),
        "uart_rx": counter_stalls(
            status, "uart_rx_bytes", time_key="uptime_ms", time_scale=1000),
        "uplink_queued": counter_stalls(
            status, "uplink_queued_bytes", time_key="uptime_ms", time_scale=1000),
        "uplink_sent": counter_stalls(
            status, "uplink_sent_bytes", time_key="uptime_ms", time_scale=1000),
    }
    heartbeat = heartbeat_summary(controls, threshold_seconds, observation_end=end)
    receive = event_gap_summary(
        receives, time_key="at_seconds", start=start, end=end)

    downlink_longest = stages["esp32_downlink"].get("longest") or {}
    if downlink_longest:
        interval_start = numeric(downlink_longest.get("start"))
        interval_end = numeric(downlink_longest.get("end"))
        stages["esp32_downlink"]["uart_rx_delta_during_longest"] = related_delta(
            status, "uart_rx_bytes", interval_start * 1000, interval_end * 1000,
            "uptime_ms")

    return {
        "input": {
            "device_id": document.get("device_id"),
            "requested_duration_seconds": document.get("requested_duration_seconds"),
            "stream_start_seconds": round(start, 6),
            "stream_end_seconds": round(end, 6),
        },
        "sample_quality": {
            "cloud_health": sample_quality(health_raw),
            "device_status": sample_quality(status_raw),
            "device_status_sorted_by_uptime": True,
        },
        "heartbeat": heartbeat,
        "receive": receive,
        "stages": stages,
        "diagnosis": diagnose(stages, heartbeat, receive, threshold_seconds),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--threshold-seconds", type=float, default=3.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    document = json.loads(args.input.read_text(encoding="utf-8"))
    result = analyze(document, args.threshold_seconds)
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    print(rendered)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
