#!/usr/bin/env python3
"""Compile the C encoder and decode its deterministic fixtures in Python."""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
TOOL = Path("/tmp/cloud_waveform_codec_regression")
sys.path.insert(0, str(ROOT / "tools" / "remote_mqtt_python"))

from waveform_codec import WaveformDecoder  # noqa: E402


def compile_tool() -> None:
    subprocess.run(
        [
            "cc", "-std=c11", "-Wall", "-Wextra", "-Werror",
            "-Iscripts/host_include", "-Imain",
            "main/cloud_waveform_codec.c",
            "scripts/cloud_waveform_codec_regression.c",
            "-lz", "-o", str(TOOL),
        ],
        cwd=ROOT,
        check=True,
    )


def main() -> None:
    compile_tool()
    subprocess.run([str(TOOL)], check=True)
    document = json.loads(
        (ROOT / "fixtures" / "cloud-waveform-codec-v1.json").read_text(encoding="utf-8")
    )
    for fixture in document["fixtures"]:
        raw = base64.b64decode(fixture["raw_b64"])
        encoded = subprocess.run(
            [str(TOOL), "--encode"],
            input=raw,
            stdout=subprocess.PIPE,
            check=True,
        ).stdout
        decoded = WaveformDecoder().decode(encoded, True)
        assert decoded == raw
        assert hashlib.sha256(decoded).hexdigest() == fixture["raw_sha256"]
    print("cloud waveform cross-language regression passed")


if __name__ == "__main__":
    main()
