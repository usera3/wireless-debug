#!/usr/bin/env python3
import importlib.util
from copy import deepcopy
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("cloud_osc_timeline_analysis.py")
spec = importlib.util.spec_from_file_location("cloud_osc_timeline_analysis", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def heartbeat(sequence, at, *, response_delay=0.1, schedule_lag_ms=0.0):
    event = {
        "sequence": sequence,
        "label": "heartbeat",
        "status": "sent",
        "scheduled_at_seconds": at,
        "send_started_at_seconds": at + schedule_lag_ms / 1000,
        "send_completed_at_seconds": at + schedule_lag_ms / 1000 + 0.001,
        "schedule_lag_ms": schedule_lag_ms,
        "send_duration_ms": 1.0,
    }
    if response_delay is not None:
        event["response_at_seconds"] = event["send_started_at_seconds"] + response_delay
        event["round_trip_ms"] = response_delay * 1000
    return event


def status(at, uptime, downlink, tx, rx, queued, sent):
    return {
        "at_seconds": at,
        "uptime_ms": uptime,
        "uplink_downlink_frames": downlink,
        "uart_tx_bytes": tx,
        "uart_rx_bytes": rx,
        "uplink_queued_bytes": queued,
        "uplink_sent_bytes": sent,
        "fetch_duration_ms": 20,
    }


document = {
    "device_id": "wd-test",
    "requested_duration_seconds": 6,
    "transport_timeline": {
        "stream_started_at_seconds": 0,
        "stream_ended_at_seconds": 6,
        "control_sends": [heartbeat(index + 1, index) for index in range(6)],
        "receives": [
            {"at_seconds": index + 0.1, "bytes": 250, "heartbeat_matches": 1}
            for index in range(6)
        ],
    },
    "cloud_health_timeline": [
        {"at_seconds": index, "ws_downlink_sent_frames": 100 + index,
         "fetch_duration_ms": 5}
        for index in range(7)
    ],
    # Deliberately out of uptime order to verify normalization.
    "status_timeline": [
        status(2, 12000, 12, 96, 3000, 3000, 3000),
        status(0, 10000, 10, 80, 1000, 1000, 1000),
        status(1, 11000, 11, 88, 2000, 2000, 2000),
        status(4, 14000, 14, 112, 5000, 5000, 5000),
        status(3, 13000, 13, 104, 4000, 4000, 4000),
        status(5, 15000, 15, 120, 6000, 6000, 6000),
        status(6, 16000, 16, 128, 7000, 7000, 7000),
    ],
}

smooth = module.analyze(document)
assert smooth["diagnosis"]["stage"] == "no_threshold_breach"
assert smooth["sample_quality"]["device_status_sorted_by_uptime"] is True
assert smooth["heartbeat"]["sent"] == 6
assert smooth["heartbeat"]["responses"] == 6
assert smooth["heartbeat"]["censored_unmatched"] == 0
assert smooth["receive"]["max_seconds"] < 3

cloud_stall = deepcopy(document)
cloud_stall["cloud_health_timeline"] = [
    {"at_seconds": 0, "ws_downlink_sent_frames": 100},
    {"at_seconds": 1, "ws_downlink_sent_frames": 101},
    {"at_seconds": 2, "ws_downlink_sent_frames": 101},
    {"at_seconds": 3, "ws_downlink_sent_frames": 101},
    {"at_seconds": 4, "ws_downlink_sent_frames": 101},
    {"at_seconds": 5, "ws_downlink_sent_frames": 102},
    {"at_seconds": 6, "ws_downlink_sent_frames": 103},
]
cloud_result = module.analyze(cloud_stall)
assert cloud_result["stages"]["cloud_downlink"]["max_seconds"] == 3
assert cloud_result["diagnosis"]["stage"] == "cloud_downlink_forwarding"

client_stall = deepcopy(cloud_stall)
client_stall["transport_timeline"]["control_sends"][2] = heartbeat(
    3, 2, schedule_lag_ms=3500)
client_result = module.analyze(client_stall)
assert client_result["heartbeat"]["max_schedule_lag_ms"] == 3500
assert client_result["diagnosis"]["stage"] == "client_scheduler"

censored = deepcopy(document)
censored["transport_timeline"]["control_sends"][-1] = heartbeat(
    6, 5, response_delay=None)
censored_result = module.analyze(censored)
assert censored_result["heartbeat"]["unmatched"] == 1
assert censored_result["heartbeat"]["censored_unmatched"] == 1
assert censored_result["heartbeat"]["threshold_breaches"] == []

source_continues = deepcopy(document)
source_continues["status_timeline"] = [
    status(0, 10000, 10, 80, 1000, 1000, 1000),
    status(1, 11000, 11, 88, 2000, 2000, 2000),
    status(2, 12000, 11, 88, 3000, 3000, 3000),
    status(3, 13000, 11, 88, 4000, 4000, 4000),
    status(4, 14000, 11, 88, 5000, 5000, 5000),
    status(5, 15000, 12, 96, 6000, 6000, 6000),
    status(6, 16000, 13, 104, 7000, 7000, 7000),
]
source_result = module.analyze(source_continues)
assert source_result["stages"]["esp32_downlink"]["max_seconds"] == 3
assert source_result["stages"]["esp32_downlink"]["uart_rx_delta_during_longest"] == 3000

print("cloud osc timeline analysis regression passed")
