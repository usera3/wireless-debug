"""Lossless wire codec for the ESP32 cloud waveform uplink."""

from __future__ import annotations

import struct
import time
import zlib
from dataclasses import dataclass


CAPABILITY_MARKER = b"WDC1"
MAGIC = b"WDZ1"
CODEC_RAW = 0
CODEC_DEFLATE = 1
HEADER = struct.Struct("!4sB3xII")
DEFAULT_MAX_RAW_BYTES = 32768


class WaveformCodecError(ValueError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class DecodeResult:
    payload: bytes | None
    activate: bool
    codec: str
    raw_bytes: int
    wire_bytes: int
    decode_us: int


def _elapsed_us(start_ns: int) -> int:
    return max(0, (time.perf_counter_ns() - start_ns) // 1000)


def decode_uplink_message(
    data: bytes,
    envelope_active: bool,
    max_raw_bytes: int = DEFAULT_MAX_RAW_BYTES,
) -> DecodeResult:
    wire = bytes(data)
    if not envelope_active:
        if wire == CAPABILITY_MARKER:
            return DecodeResult(None, True, "control", 0, len(wire), 0)
        return DecodeResult(wire, False, "legacy", len(wire), len(wire), 0)

    started_ns = time.perf_counter_ns()
    if len(wire) < HEADER.size or wire[:4] != MAGIC:
        raise WaveformCodecError("bad_magic")
    if wire[5:8] != b"\x00\x00\x00":
        raise WaveformCodecError("bad_reserved")

    _magic, codec, raw_len, expected_crc = HEADER.unpack_from(wire)
    if codec not in (CODEC_RAW, CODEC_DEFLATE):
        raise WaveformCodecError("unsupported_codec")
    if raw_len <= 0 or raw_len > max_raw_bytes:
        raise WaveformCodecError("invalid_raw_length")

    encoded = wire[HEADER.size :]
    if codec == CODEC_RAW:
        if len(encoded) != raw_len:
            raise WaveformCodecError("raw_length_mismatch")
        payload = encoded
        codec_name = "raw"
    else:
        decoder = zlib.decompressobj()
        try:
            payload = decoder.decompress(encoded, raw_len + 1)
        except zlib.error as exc:
            raise WaveformCodecError("compressed_incomplete") from exc
        if len(payload) > raw_len or decoder.unconsumed_tail:
            raise WaveformCodecError("decompressed_too_large")
        if not decoder.eof:
            raise WaveformCodecError("compressed_incomplete")
        if decoder.unused_data:
            raise WaveformCodecError("compressed_trailing_data")
        tail = decoder.flush()
        if tail:
            payload += tail
            if len(payload) > raw_len:
                raise WaveformCodecError("decompressed_too_large")
        if len(payload) != raw_len:
            raise WaveformCodecError("decompressed_length_mismatch")
        codec_name = "deflate"

    if zlib.crc32(payload) & 0xFFFFFFFF != expected_crc:
        raise WaveformCodecError("crc_mismatch")
    return DecodeResult(
        payload=payload,
        activate=False,
        codec=codec_name,
        raw_bytes=len(payload),
        wire_bytes=len(wire),
        decode_us=_elapsed_us(started_ns),
    )
