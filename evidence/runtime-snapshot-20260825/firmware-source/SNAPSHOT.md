# Firmware Source Snapshot

This is the buildable firmware source used for the 2026-08-25 image.

- Source commit: `4148575eebceb77924f392ebd6a662df59b43466`
- Direct parent: `2c548ac95309fd10d9cd5161ef07f8f07e19485f`
- Baseline commit: `6cb4de293d392394707ff7dc92dd78d782ee82f6`
- Frontend assets: `22fb25a74c2df98bb0f7ca0e65dca595a5e2ac51`
- ESP-IDF: 6.0
- Target: ESP32-S3, 8 MB flash

The snapshot contains the root build configuration, dependency lock, partition
layout, `main/` application source, WebSocket component patch, SDK configuration,
and the exact `dist/` assets embedded into `storage.bin`.

The matching binaries are in [`../firmware-flash/`](../firmware-flash/).
