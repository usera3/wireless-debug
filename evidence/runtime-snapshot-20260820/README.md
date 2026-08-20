# Runtime Snapshot: 2026-08-20

This directory records the firmware currently used by the ESP32-S3 board and
the cloud runtime currently deployed on private host 183.

## Firmware

- Source branch: `cloud-lb-migration-20260818`
- Source commit: `6cb4de2`
- Source tag: `firmware-oled-ap-ssid-visible-20260818`
- Target: ESP32-S3, 8 MB flash, DIO, 80 MHz
- Cloud endpoints compiled into this firmware:
  - MQTT: `mqtt://39.108.83.25:1883`
  - WebSocket uplink: `ws://39.108.83.25:18089`

The four partition images and a complete 8 MB image are under
[`firmware-flash/`](firmware-flash/). From the repository root, the same
package is linked by [`FLASHING.md`](../../FLASHING.md). For a complete restore, flash
`firmware-flash/full_flash_0x0.bin` at offset `0x0`. The split image layout is
documented in `firmware-flash/README.md`.

The firmware image hashes were independently compared with the local ESP-IDF
build output. The application image is the image used for the August 18
hardware checkpoint; no firmware source changes were made after that build.

## Cloud runtime

`cloud-183/source/` is a selective capture of the files running on host 183,
not a reconstruction from an earlier Git commit. The host's application tree
does not contain a Git repository. The deployment record identifies the
historical base commits, but the captured files and their SHA-256 values are
authoritative because `app/app.py` contains later runtime edits.

The capture excludes passwords, tokens, `.env` secrets, credentials, database
data, certificates, keys, caches, and backups. `cloud-183/deployment/app.env.redacted`
contains only non-secret runtime settings needed to understand the deployment.

## Verification performed

On 2026-08-20 the 183 runtime was checked through the VNT SSH path:

- Supervisor: `cloud`, `mosquitto`, and `postgres` were `RUNNING`.
- Listeners: `18080`, `18088`, `18089`, and `1883` were open locally.
- HTTP test page: `200`.
- Plain HTTP request to WebSocket port `18089`: `426` (expected upgrade response).
- MQTT protocol probe: CONNACK `0x20 0x02 0x00 0x00`.
- Captured source hashes matched `cloud-183/deployment/source-sha256.txt`.

No board-status file is included because the board was not connected during
this snapshot capture; the firmware images and source commit are the
authoritative board version record.
