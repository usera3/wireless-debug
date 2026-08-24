#!/usr/bin/env python3
"""Regression coverage for the cloud waveform wire codec."""

from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools" / "remote_mqtt_python"))

from waveform_codec import (  # noqa: E402
    CAPABILITY_MARKER,
    CODEC_DEFLATE,
    CODEC_RAW,
    HEADER,
    MAGIC,
    WaveformCodecError,
    decode_uplink_message,
)


def envelope(codec: int, raw: bytes, payload: bytes | None = None, crc: int | None = None) -> bytes:
    encoded = raw if payload is None else payload
    checksum = zlib.crc32(raw) & 0xFFFFFFFF if crc is None else crc
    return HEADER.pack(MAGIC, codec, len(raw), checksum) + encoded


def expect_error(reason: str, data: bytes) -> None:
    try:
        decode_uplink_message(data, envelope_active=True)
    except WaveformCodecError as exc:
        assert exc.reason == reason, (exc.reason, reason)
    else:
        raise AssertionError(f"expected codec error: {reason}")


legacy = bytes.fromhex("ff77aa55000000410f91")
legacy_result = decode_uplink_message(legacy, envelope_active=False)
assert legacy_result.payload == legacy
assert legacy_result.activate is False
assert legacy_result.codec == "legacy"
assert legacy_result.raw_bytes == len(legacy)
assert legacy_result.wire_bytes == len(legacy)

activation = decode_uplink_message(CAPABILITY_MARKER, envelope_active=False)
assert activation.payload is None
assert activation.activate is True
assert activation.codec == "control"

raw = (bytes.fromhex("ff77aa55") + b"\x00" * 128) * 8
raw_result = decode_uplink_message(envelope(CODEC_RAW, raw), envelope_active=True)
assert raw_result.payload == raw
assert raw_result.codec == "raw"
assert raw_result.decode_us >= 0

compressed = zlib.compress(raw, level=1)
wire = envelope(CODEC_DEFLATE, raw, compressed)
decoded = decode_uplink_message(wire, envelope_active=True)
assert decoded.payload == raw
assert decoded.codec == "deflate"
assert decoded.raw_bytes == len(raw)
assert decoded.wire_bytes == len(wire)
assert decoded.decode_us >= 0

expect_error("bad_magic", b"BAD!" + wire[4:])

bad_reserved = bytearray(wire)
bad_reserved[5] = 1
expect_error("bad_reserved", bytes(bad_reserved))

expect_error("unsupported_codec", envelope(7, raw))
expect_error("invalid_raw_length", HEADER.pack(MAGIC, CODEC_RAW, 0, 0))
expect_error(
    "invalid_raw_length",
    HEADER.pack(MAGIC, CODEC_RAW, 32769, 0) + b"x",
)
expect_error(
    "raw_length_mismatch",
    HEADER.pack(MAGIC, CODEC_RAW, len(raw) + 1, zlib.crc32(raw)) + raw,
)
expect_error(
    "compressed_trailing_data",
    envelope(CODEC_DEFLATE, raw, compressed + b"trailing"),
)
expect_error(
    "decompressed_too_large",
    HEADER.pack(MAGIC, CODEC_DEFLATE, 16, zlib.crc32(raw)) + compressed,
)
short_raw = raw[:-1]
expect_error(
    "decompressed_length_mismatch",
    HEADER.pack(MAGIC, CODEC_DEFLATE, len(raw), zlib.crc32(short_raw))
    + zlib.compress(short_raw, level=1),
)
expect_error(
    "compressed_incomplete",
    envelope(CODEC_DEFLATE, raw, compressed[:-2]),
)
expect_error("crc_mismatch", envelope(CODEC_RAW, raw, crc=0))

print("cloud waveform codec regression passed")
