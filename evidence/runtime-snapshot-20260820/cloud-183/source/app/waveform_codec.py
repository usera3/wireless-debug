"""Negotiated lossless waveform envelopes for the cloud uplink."""

from __future__ import annotations

from collections import Counter
import struct
import threading
import time
import zlib


CAPABILITY = b"WDC1"
MAGIC = b"WDZ1"
CODEC_RAW = 0
CODEC_ZLIB = 1
MAX_RAW_BYTES = 32768
HEADER = struct.Struct("!4sB3sII")


class WaveformDecodeError(ValueError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def encode_envelope(raw: bytes, force_raw: bool = False) -> bytes:
    """Build deterministic test/fixture envelopes using Python zlib level 1."""
    payload = bytes(raw)
    if not 0 < len(payload) <= MAX_RAW_BYTES:
        raise ValueError("raw waveform length out of range")

    codec = CODEC_RAW
    encoded = payload
    if not force_raw:
        compressed = zlib.compress(payload, level=1)
        if len(compressed) < len(payload):
            codec = CODEC_ZLIB
            encoded = compressed
    checksum = zlib.crc32(payload) & 0xFFFFFFFF
    return HEADER.pack(MAGIC, codec, b"\x00\x00\x00", len(payload), checksum) + encoded


def _decode(message: bytes, compression_active: bool) -> tuple[bytes, str]:
    if not compression_active:
        return message, "legacy_raw"
    if len(message) < HEADER.size:
        raise WaveformDecodeError("short_header")

    magic, codec, reserved, raw_len, checksum = HEADER.unpack(message[:HEADER.size])
    if magic != MAGIC:
        raise WaveformDecodeError("bad_magic")
    if reserved != b"\x00\x00\x00":
        raise WaveformDecodeError("reserved_nonzero")
    if codec not in (CODEC_RAW, CODEC_ZLIB):
        raise WaveformDecodeError("unsupported_codec")
    if not 0 < raw_len <= MAX_RAW_BYTES:
        raise WaveformDecodeError("invalid_length")

    encoded = message[HEADER.size:]
    if codec == CODEC_RAW:
        if len(encoded) != raw_len:
            raise WaveformDecodeError("raw_size_mismatch")
        raw = encoded
        kind = "raw_envelope"
    else:
        decompressor = zlib.decompressobj()
        try:
            raw = decompressor.decompress(encoded, raw_len + 1)
            if len(raw) > raw_len or decompressor.unconsumed_tail:
                raise WaveformDecodeError("length_mismatch")
            raw += decompressor.flush(raw_len + 1 - len(raw))
        except WaveformDecodeError:
            raise
        except zlib.error as exc:
            raise WaveformDecodeError("compressed_stream") from exc
        if decompressor.unused_data:
            raise WaveformDecodeError("trailing_data")
        if not decompressor.eof:
            raise WaveformDecodeError("compressed_stream")
        if len(raw) != raw_len:
            raise WaveformDecodeError("length_mismatch")
        kind = "compressed"

    if (zlib.crc32(raw) & 0xFFFFFFFF) != checksum:
        raise WaveformDecodeError("crc_mismatch")
    return raw, kind


class WaveformDecoder:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._wire_bytes = 0
        self._decoded_raw_bytes = 0
        self._activations = 0
        self._compressed_messages = 0
        self._raw_envelope_messages = 0
        self._legacy_raw_messages = 0
        self._decode_failures: Counter[str] = Counter()
        self._decode_total_us = 0
        self._decode_max_us = 0

    @staticmethod
    def _elapsed_us(started_ns: int) -> int:
        return max(0, (time.perf_counter_ns() - started_ns) // 1000)

    def decode(self, message: bytes, compression_active: bool) -> bytes:
        data = bytes(message)
        started_ns = time.perf_counter_ns()
        try:
            raw, kind = _decode(data, compression_active)
        except WaveformDecodeError as exc:
            elapsed_us = self._elapsed_us(started_ns)
            with self._lock:
                self._wire_bytes += len(data)
                self._decode_failures[exc.reason] += 1
                self._decode_total_us += elapsed_us
                self._decode_max_us = max(self._decode_max_us, elapsed_us)
            raise

        elapsed_us = self._elapsed_us(started_ns)
        with self._lock:
            self._wire_bytes += len(data)
            self._decoded_raw_bytes += len(raw)
            if kind == "compressed":
                self._compressed_messages += 1
            elif kind == "raw_envelope":
                self._raw_envelope_messages += 1
            else:
                self._legacy_raw_messages += 1
            self._decode_total_us += elapsed_us
            self._decode_max_us = max(self._decode_max_us, elapsed_us)
        return raw

    def note_activation(self) -> None:
        with self._lock:
            self._activations += 1

    def snapshot(self) -> dict[str, object]:
        with self._lock:
            return {
                "wire_bytes": self._wire_bytes,
                "decoded_raw_bytes": self._decoded_raw_bytes,
                "activations": self._activations,
                "compressed_messages": self._compressed_messages,
                "raw_envelope_messages": self._raw_envelope_messages,
                "legacy_raw_messages": self._legacy_raw_messages,
                "decode_failures": dict(sorted(self._decode_failures.items())),
                "decode_total_us": self._decode_total_us,
                "decode_max_us": self._decode_max_us,
            }


class UplinkWaveformSession:
    """Connection-local negotiation state around the process-wide decoder."""

    def __init__(self, decoder: WaveformDecoder) -> None:
        self._decoder = decoder
        self.compression_active = False

    @staticmethod
    def is_offer(data: bytes) -> bool:
        return bytes(data) == CAPABILITY

    def mark_reply_sent(self) -> None:
        if self.compression_active:
            return
        self.compression_active = True
        self._decoder.note_activation()

    def decode(self, data: bytes) -> bytes:
        return self._decoder.decode(data, self.compression_active)
