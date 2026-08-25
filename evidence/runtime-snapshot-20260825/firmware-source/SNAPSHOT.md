# Firmware Source Snapshot

This is the buildable firmware source used for the 2026-08-25 image.

- Source commit: `f3e705cabdad6e02478a02f47ac4ac4f57ff72cd`
- Direct parent: `2c548ac95309fd10d9cd5161ef07f8f07e19485f`
- Baseline commit: `6cb4de293d392394707ff7dc92dd78d782ee82f6`
- Frontend assets: `fd40805932197928f8f9f57f25064944ffd35248`
- ESP-IDF: 6.0
- Target: ESP32-S3, 8 MB flash

The snapshot contains the root build configuration, dependency lock, partition
layout, `main/` application source, WebSocket component patch, SDK configuration,
and the exact `dist/` assets embedded into `storage.bin`.

The cloud status heartbeat includes the real SoftAP SSID. Host 183 uses its
first and last identity segments for default device names such as
`ESP32-S3_AP_7C9D -> ESP32_7C9D`, while preserving manually assigned names.

The matching binaries are in [`../firmware-flash/`](../firmware-flash/).
