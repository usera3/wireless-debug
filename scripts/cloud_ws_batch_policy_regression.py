#!/usr/bin/env python3
"""Compile and run the cloud WebSocket batch deadline policy regression."""

from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
BINARY = Path("/tmp/cloud_ws_batch_policy_regression")


def main() -> None:
    subprocess.run(
        [
            "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-Imain",
            "main/cloud_ws_batch_policy.c",
            "scripts/cloud_ws_batch_policy_regression.c",
            "-o", str(BINARY),
        ],
        cwd=ROOT,
        check=True,
    )
    subprocess.run([str(BINARY)], check=True)


if __name__ == "__main__":
    main()
