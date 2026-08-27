# Runtime Snapshot: 2026-08-27

This directory is the self-contained 2026-08-27 release. It keeps the current
firmware and cloud source, the complete ESP32-S3 flash package, editable web
source, deployed web assets, and host 183 deployment evidence under one date.

## Contents

- [`firmware-source/`](firmware-source/): current combined source at `fc022fa`
- [`firmware-flash/`](firmware-flash/): split images and complete 8 MiB image from `f3e705c`
- [`web-source/`](web-source/): editable frontend source from `fd40805`
- [`cloud-183/`](cloud-183/): current host 183 backend, web assets, and deployment record
- [`ELF_ADDRESS_PICKER.md`](ELF_ADDRESS_PICKER.md): variable, structure, and array address-resolution design note

## Source Provenance

- Snapshot source commit: `fc022fa9b19f6bd59beb2324cc8f21ad19c1c20d`
- Firmware binary commit: `f3e705cabdad6e02478a02f47ac4ac4f57ff72cd`
- Frontend source and deployed asset commit: `fd40805932197928f8f9f57f25064944ffd35248`
- OLED/AP-name baseline: `6cb4de293d392394707ff7dc92dd78d782ee82f6`

The changes from `f3e705c` to `fc022fa` are confined to the cloud parameter
table upload implementation and its tests. No firmware build input changed, so
the flash images remain the matching current firmware artifacts from `f3e705c`.

## Firmware Flash Package

[`firmware-flash/full_flash_0x0.bin`](firmware-flash/full_flash_0x0.bin) is an
8 MiB image written at offset `0x0`. The same package also contains the four
split images and their offsets:

```text
0x000000  bootloader.bin
0x008000  partition-table.bin
0x010000  uart_ble_wifi.bin
0x290000  storage.bin
```

Verify the package with
[`firmware-flash/SHA256SUMS`](firmware-flash/SHA256SUMS). The full image's four
documented regions must match the split images byte for byte.

## Web And Host 183

Editable frontend source is under [`web-source/source/`](web-source/source/).
The deployed browser bundle is also present in `cloud-183/source/dist/orig/`
and in the firmware source `dist/orig/` used to build `storage.bin`.

The complete host 183 application snapshot is under
[`cloud-183/source/`](cloud-183/source/). On 2026-08-27, its source and asset
hashes were checked against `/apps/svr/wireless-debug-cloud`, and Supervisor
reported `cloud`, `mosquitto`, and `postgres` running. The current cloud backend
accepts browser multipart uploads while preserving the legacy raw and Base64
JSON parameter-table upload formats.

## Verification Record

- The split images match the active ESP-IDF build outputs.
- `full_flash_0x0.bin` is exactly 8 MiB and contains all four split images at
  their documented offsets.
- The firmware package was flashed to COM4 with esptool write verification.
- A real 47,495-byte `ParameterTable.xlsx` passed local and server upload/load
  validation against the deployed host 183 backend.
- Host 183 source and deployed asset hashes are recorded in
  `cloud-183/deployment/source-sha256.txt`.
