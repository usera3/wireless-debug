#!/usr/bin/env python3
"""Regression guard for reconnecting STA without rebuilding the SoftAP."""

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "main" / "wifi_manager.c").read_text(encoding="utf-8")

match = re.search(
    r"static esp_err_t start_apsta_connect_locked\(void\)\n\{(?P<body>[\s\S]*?)\n\}\n\nesp_err_t wifi_manager_scan",
    SOURCE,
)
if not match:
    raise AssertionError("could not locate start_apsta_connect_locked")
body = match.group("body")

assert re.search(
    r"bool preserve_apsta\s*=\s*s_driver_started\s*&&\s*"
    r"s_net_mode\s*==\s*SYSTEM_NET_APSTA",
    body,
), "APSTA reconnect must detect an already-running APSTA driver"
assert re.search(
    r"if\s*\(preserve_apsta\)[\s\S]*?configure_sta_locked\(\)[\s\S]*?"
    r"else\s*\{[\s\S]*?start_apsta_locked\(\)",
    body,
), "APSTA reconnect must update STA config in place and rebuild only when needed"

print("wifi APSTA reconnect regression passed")
