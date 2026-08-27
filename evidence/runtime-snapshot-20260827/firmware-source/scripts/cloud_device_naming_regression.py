#!/usr/bin/env python3
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools' / 'remote_mqtt_python'))

from device_naming import (  # noqa: E402
    auto_display_name_from_ap_ssid,
    auto_display_name_from_device_id,
    auto_display_name_from_device_mac,
    choose_device_display_name,
    is_legacy_auto_display_name,
)


assert auto_display_name_from_ap_ssid('ESP32-S3_AP_7C9D') == 'ESP32_7C9D'
assert auto_display_name_from_ap_ssid('ESP32-S3_AP_b885') == 'ESP32_B885'
assert auto_display_name_from_ap_ssid('LAB-BOARD_AP_A123') == 'LAB_A123'
assert auto_display_name_from_ap_ssid('ESP32-S3') is None
assert auto_display_name_from_ap_ssid('') is None

assert auto_display_name_from_device_mac('ac:27:6e:ab:7c:9c') == 'ESP32_7C9D'
assert auto_display_name_from_device_mac('AC-27-6E-AB-7C-FF') == 'ESP32_7D00'
assert auto_display_name_from_device_mac('invalid') is None
assert auto_display_name_from_device_id('wd-ac276eab7c9c') == 'ESP32_7C9D'
assert auto_display_name_from_device_id('custom-device') is None

assert is_legacy_auto_display_name('ESP32-001')
assert is_legacy_auto_display_name('esp32-999')
assert not is_legacy_auto_display_name('ESP32_7C9D')
assert not is_legacy_auto_display_name('实验室主机')

assert choose_device_display_name(
    None,
    ap_ssid='ESP32-S3_AP_7C9D',
    device_mac='ac:27:6e:ab:7c:9c',
    used_names=set(),
) == 'ESP32_7C9D'
assert choose_device_display_name(
    'ESP32-002',
    ap_ssid=None,
    device_mac=None,
    device_id='wd-a4cb8fc6b884',
    used_names=set(),
) == 'ESP32_B885'
assert choose_device_display_name(
    '实验室主机',
    ap_ssid='ESP32-S3_AP_7C9D',
    device_mac='ac:27:6e:ab:7c:9c',
    used_names=set(),
) == '实验室主机'
assert choose_device_display_name(
    'ESP32-003',
    ap_ssid='ESP32-S3_AP_7C9D',
    device_mac='ac:27:6e:ab:7c:9c',
    used_names={'esp32_7c9d', 'ESP32_7C9D_2'},
) == 'ESP32_7C9D_3'

print('cloud device naming regression passed')
