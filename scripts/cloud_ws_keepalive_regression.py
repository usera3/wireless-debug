#!/usr/bin/env python3
"""Ensure continuous waveform traffic isn't killed by protocol keepalive pings."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP = (ROOT / "tools" / "remote_mqtt_python" / "app.py").read_text(encoding="utf-8")

serve_call = APP.split("with serve(", 1)[1].split(") as server:", 1)[0]
assert "ping_interval=None" in serve_call, (
    "cloud waveform websocket must disable automatic keepalive pings; "
    "continuous device frames and MQTT status already prove liveness"
)

print("cloud websocket keepalive regression passed")
