#!/usr/bin/env python3
"""Regression checks for cloud waveform capability negotiation integration."""

from __future__ import annotations

from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[1]
MODULE_DIR = ROOT / "tools" / "remote_mqtt_python"
APP_PATH = MODULE_DIR / "app.py"
DOCKERFILE_PATH = MODULE_DIR / "Dockerfile"
COMPOSE_PATH = MODULE_DIR / "docker-compose.yml"
ENV_EXAMPLE_PATH = MODULE_DIR / ".env.example"
sys.path.insert(0, str(MODULE_DIR))

from waveform_codec import (  # noqa: E402
    CAPABILITY,
    UplinkWaveformSession,
    WaveformDecoder,
    encode_envelope,
)


def test_session_activation_requires_reply() -> None:
    raw = b"waveform-fixture"
    decoder = WaveformDecoder()
    session = UplinkWaveformSession(decoder)

    assert session.decode(b"legacy") == b"legacy"
    assert session.compression_active is False
    assert session.is_offer(CAPABILITY) is True
    assert session.is_offer(b"WDC1x") is False
    assert session.compression_active is False

    session.mark_reply_sent()
    session.mark_reply_sent()
    assert session.compression_active is True
    assert session.decode(encode_envelope(raw)) == raw
    assert decoder.snapshot()["activations"] == 1

    replacement = UplinkWaveformSession(decoder)
    assert replacement.compression_active is False
    assert replacement.decode(b"new-legacy") == b"new-legacy"


def test_app_orders_negotiation_before_decode_and_fanout() -> None:
    source = APP_PATH.read_text(encoding="utf-8")
    handler = source[
        source.index("def cloud_ws_uplink_handler"):
        source.index("def cloud_ws_handler")
    ]
    assert handler.index("session.is_offer(data)") < handler.index("session.decode(data)")
    assert handler.index("cloud_ws_downlinks.send") < handler.index(
        "session.mark_reply_sent"
    )
    assert handler.index("session.decode(data)") < handler.index(
        "broadcast_remote_ws_bytes(device_id, decoded)"
    )
    assert "broadcast_remote_ws_bytes(device_id, data)" not in handler
    assert "except WaveformDecodeError as exc" in handler
    assert "'waveform_codec': waveform_decoder.snapshot()" in source


def test_container_contract() -> None:
    dockerfile = DOCKERFILE_PATH.read_text(encoding="utf-8")
    compose = COMPOSE_PATH.read_text(encoding="utf-8")
    env_example = ENV_EXAMPLE_PATH.read_text(encoding="utf-8")
    app = APP_PATH.read_text(encoding="utf-8")

    assert re.search(r"COPY app\.py schema\.sql ws_fanout\.py waveform_codec\.py \./", dockerfile)
    assert "CLOUD_WS_MAX_MESSAGE_BYTES = int(os.environ.get('CLOUD_WS_MAX_MESSAGE_BYTES', '65536'))" in app
    assert re.search(r"CLOUD_WS_MAX_MESSAGE_BYTES:.*:-65536", compose)
    assert re.search(r"^CLOUD_WS_MAX_MESSAGE_BYTES=65536$", env_example, re.MULTILINE)

    assert "image: ${POSTGRES_IMAGE:-postgres:18-alpine}" in compose
    assert "image: ${MOSQUITTO_IMAGE:-eclipse-mosquitto:2}" in compose
    assert "${APP_PORT:-18088}:18088" in compose
    assert "${CLOUD_WS_PORT:-18089}:18089" in compose


def main() -> None:
    test_session_activation_requires_reply()
    test_app_orders_negotiation_before_decode_and_fanout()
    test_container_contract()
    print("cloud websocket waveform negotiation regression passed")


if __name__ == "__main__":
    main()
