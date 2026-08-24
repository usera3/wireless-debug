#!/usr/bin/env python3
"""Regression checks for the negotiated cloud waveform envelope codec."""

from __future__ import annotations

import argparse
import base64
from collections import Counter
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import random
import struct
import sys
from typing import Iterator


ROOT = Path(__file__).resolve().parents[1]
MODULE_DIR = ROOT / "tools" / "remote_mqtt_python"
FIXTURE_PATH = ROOT / "fixtures" / "cloud-waveform-codec-v1.json"
sys.path.insert(0, str(MODULE_DIR))

from waveform_codec import (  # noqa: E402
    HEADER,
    MAX_RAW_BYTES,
    WaveformDecodeError,
    WaveformDecoder,
    encode_envelope,
)


def payloads() -> dict[str, bytes]:
    rng = random.Random(0x57445A31)
    return {
        "zero_heavy": bytes(MAX_RAW_BYTES),
        "mixed": bytes((index * 37 + index // 11) & 0xFF for index in range(8192)),
        "incompressible": rng.randbytes(8192),
    }


def replace_header(
    envelope: bytes,
    *,
    magic: bytes | None = None,
    codec: int | None = None,
    reserved: bytes | None = None,
    raw_len: int | None = None,
    crc32: int | None = None,
) -> bytes:
    current = list(HEADER.unpack(envelope[:HEADER.size]))
    replacements = (magic, codec, reserved, raw_len, crc32)
    for index, value in enumerate(replacements):
        if value is not None:
            current[index] = value
    return HEADER.pack(*current) + envelope[HEADER.size:]


@contextmanager
def expect_decode_error(reason: str) -> Iterator[None]:
    try:
        yield
    except WaveformDecodeError as exc:
        assert exc.reason == reason, f"expected {reason}, got {exc.reason}"
    else:
        raise AssertionError(f"expected WaveformDecodeError({reason})")


def fixture_document() -> dict[str, object]:
    fixtures = []
    for name, raw in payloads().items():
        fixtures.append({
            "name": name,
            "raw_len": len(raw),
            "raw_sha256": hashlib.sha256(raw).hexdigest(),
            "raw_b64": base64.b64encode(raw).decode("ascii"),
            "raw_envelope_b64": base64.b64encode(
                encode_envelope(raw, force_raw=True)
            ).decode("ascii"),
            "zlib_envelope_b64": base64.b64encode(encode_envelope(raw)).decode("ascii"),
        })
    return {"version": 1, "fixtures": fixtures}


def rendered_fixtures() -> str:
    return json.dumps(fixture_document(), indent=2, sort_keys=True) + "\n"


def run_contract() -> None:
    values = payloads()
    zero_heavy = values["zero_heavy"]
    mixed = values["mixed"]
    decoder = WaveformDecoder()

    assert decoder.decode(b"legacy-uart", False) == b"legacy-uart"
    valid_zlib = encode_envelope(zero_heavy)
    valid_raw = encode_envelope(mixed, force_raw=True)
    assert decoder.decode(valid_zlib, True) == zero_heavy
    assert decoder.decode(valid_raw, True) == mixed

    initial = decoder.snapshot()
    assert initial["legacy_raw_messages"] == 1
    assert initial["compressed_messages"] == 1
    assert initial["raw_envelope_messages"] == 1

    bad_cases = [
        ("short header", "short_header", b"WDZ1"),
        ("bad magic", "bad_magic", replace_header(valid_raw, magic=b"BAD1")),
        (
            "reserved nonzero",
            "reserved_nonzero",
            replace_header(valid_raw, reserved=b"\x00\x01\x00"),
        ),
        (
            "unsupported codec",
            "unsupported_codec",
            replace_header(valid_raw, codec=2),
        ),
        ("zero length", "invalid_length", replace_header(valid_raw, raw_len=0)),
        (
            "oversize length",
            "invalid_length",
            replace_header(valid_raw, raw_len=MAX_RAW_BYTES + 1),
        ),
        ("raw size mismatch", "raw_size_mismatch", valid_raw[:-1]),
        ("truncated zlib", "compressed_stream", valid_zlib[:-1]),
        ("trailing zlib data", "trailing_data", valid_zlib + b"x"),
        (
            "declared length mismatch",
            "length_mismatch",
            replace_header(valid_zlib, raw_len=len(zero_heavy) - 1),
        ),
        ("crc mismatch", "crc_mismatch", replace_header(valid_zlib, crc32=0)),
    ]
    for name, reason, envelope in bad_cases:
        with expect_decode_error(reason):
            decoder.decode(envelope, True)
        assert name

    snapshot = decoder.snapshot()
    assert snapshot["decode_failures"] == dict(
        Counter(reason for _, reason, _ in bad_cases)
    )
    assert snapshot["wire_bytes"] > 0
    assert snapshot["decoded_raw_bytes"] == (
        len(b"legacy-uart") + len(zero_heavy) + len(mixed)
    )
    assert snapshot["decode_total_us"] >= 0
    assert snapshot["decode_max_us"] >= 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--write-fixtures", action="store_true")
    group.add_argument("--check-fixtures", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    run_contract()
    rendered = rendered_fixtures()
    if args.write_fixtures:
        FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE_PATH.write_text(rendered, encoding="utf-8")
    elif args.check_fixtures:
        assert FIXTURE_PATH.read_text(encoding="utf-8") == rendered
    print("cloud waveform codec regression passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
