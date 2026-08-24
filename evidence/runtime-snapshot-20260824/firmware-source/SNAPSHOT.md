# Firmware Source Snapshot

This is the buildable firmware source used for the 2026-08-24 image.

- Source commit: `2c548ac95309fd10d9cd5161ef07f8f07e19485f`
- Baseline commit: `6cb4de293d392394707ff7dc92dd78d782ee82f6`
- Frontend assets: `f8de10883d6ca23da706f454485d126d1df45e74`
- ESP-IDF: 6.0
- Target: ESP32-S3, 8 MB flash

The snapshot contains the root build configuration, dependency lock, partition
layout, `main/` application source, WebSocket component patch, SDK configuration,
and the exact `dist/` assets embedded into `storage.bin`.

The matching binaries are in [`../firmware-flash/`](../firmware-flash/).
