#!/usr/bin/env python3
"""Verify local routing backpressure cannot block the UART data plane."""

from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
BINARY = Path("/tmp/router_service_backpressure_regression")


def function_body(source: str, signature: str) -> str:
    start = source.index(signature)
    brace = source.index("{", start)
    depth = 0
    for offset in range(brace, len(source)):
        if source[offset] == "{":
            depth += 1
        elif source[offset] == "}":
            depth -= 1
            if depth == 0:
                return source[brace:offset + 1]
    raise AssertionError(f"unterminated function: {signature}")


def main() -> None:
    wifi_source = (ROOT / "main" / "wifi_transport.c").read_text(encoding="utf-8")
    send_body = function_body(wifi_source, "size_t wifi_transport_send(")
    assert "ESP_LOGW" not in send_body, (
        "wifi_transport_send must use counters, not synchronous warning logs, "
        "when its non-blocking queue is backpressured"
    )

    subprocess.run(
        [
            "cc", "-std=c11", "-Wall", "-Wextra", "-Werror",
            "-Iscripts/host_include", "-Imain",
            "main/router_service.c",
            "scripts/router_service_backpressure_regression.c",
            "-o", str(BINARY),
        ],
        cwd=ROOT,
        check=True,
    )
    subprocess.run([str(BINARY)], check=True)
    print("router service backpressure regression passed")


if __name__ == "__main__":
    main()
