# Firmware Source Snapshot

This is the current combined source captured for the 2026-08-27 runtime
snapshot.

- Snapshot source commit: `fc022fa9b19f6bd59beb2324cc8f21ad19c1c20d`
- Matching firmware binary commit: `f3e705cabdad6e02478a02f47ac4ac4f57ff72cd`
- Direct firmware parent: `2c548ac95309fd10d9cd5161ef07f8f07e19485f`
- OLED/AP-name baseline: `6cb4de293d392394707ff7dc92dd78d782ee82f6`
- Frontend assets: `fd40805932197928f8f9f57f25064944ffd35248`
- ESP-IDF: 6.0
- Target: ESP32-S3, 8 MiB flash

The snapshot contains the root build configuration, dependency lock, partition
layout, `main/` application source, WebSocket component patch, SDK
configuration, exact `dist/` assets embedded into `storage.bin`, cloud service
source, and regression tests.

The only changes after the firmware binary commit are the host cloud parameter
table upload codec, request handling, container dependency, and regression
tests. No ESP-IDF firmware input changed between `f3e705c` and `fc022fa`.

The matching flash package is in [`../firmware-flash/`](../firmware-flash/).
