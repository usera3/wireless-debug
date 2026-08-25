# Runtime Snapshot: 2026-08-25

This directory is the self-contained 2026-08-25 release. It keeps the exact
firmware source, ESP32-S3 flash package, editable web source, and the complete
host 183 cloud application together under one date.

## Contents

- [`firmware-source/`](firmware-source/): buildable firmware source from `f3e705c`
- [`firmware-flash/`](firmware-flash/): build-verified split images and complete 8 MB image
- [`web-source/`](web-source/): editable frontend source from `fd40805`
- [`cloud-183/`](cloud-183/): host 183 backend, deployment record, and deployed web assets
- [`ELF_ADDRESS_PICKER.md`](ELF_ADDRESS_PICKER.md): variable-name search and address-resolution design note

## Firmware

- Firmware source commit: `f3e705c` (`feature/elf-struct-array-index-20260825-fw`)
- Direct firmware parent: `2c548ac` (the verified 2026-08-24 snapshot source)
- OLED/AP-name baseline: `6cb4de2` (`firmware-oled-ap-ssid-visible-20260818`)
- Tested frontend asset commit: `fd40805`
- Target: ESP32-S3, 8 MB flash, DIO, 80 MHz
- Application image: `0x19af60` bytes, with about `0xe50a0` bytes free in the app partition

The complete image is in
[`firmware-flash/full_flash_0x0.bin`](firmware-flash/full_flash_0x0.bin) and
must be written at offset `0x0`. Verify all package files with
[`firmware-flash/SHA256SUMS`](firmware-flash/SHA256SUMS).

## Frontend

The editable source is under [`web-source/source/`](web-source/source/). The
generated browser assets are stored in the firmware source `dist/orig/`, the
embedded `storage.bin`, and the host 183 `cloud-183/source/dist/orig/` runtime.

## Host 183

The complete cloud source is under [`cloud-183/source/`](cloud-183/source/).
Its application and static assets were deployed through the VNT SSH path. The
pre-deployment runtime was backed up as
`/apps/backups/wireless-debug-cloud/pre-device-naming-20260825T174136.tar.gz`;
only the `cloud` Supervisor program was restarted. Mosquitto and PostgreSQL
were not restarted. Legacy automatic names were migrated to `ESP32_B849`,
`ESP32_B885`, and `ESP32_7C9D`.

## Verification

- Frontend lint/build, parser/UI regressions, and desktop/mobile Playwright
  acceptance passed for TI C2000 and IAR fixtures.
- ESP-IDF 6.0 build completed with `Project build complete.`
- `full_flash_0x0.bin` is exactly 8 MB and its four documented regions match
  the newly built split images. The preceding `4148575` package was flashed to
  COM4 and independently read back; this device-naming update was not
  re-flashed because host 183 can derive legacy-device names from their MAC.
- The prior hardware acceptance reported `HEALTH OK`, advertised
  `ESP32-S3_AP_7C9D`, and passed the Playwright ELF picker directly at
  `http://192.168.4.1/orig/i.html`.
- Host 183 returned HTTP 200 for health and device APIs, HTTP 426 for the
  WebSocket probe, a valid MQTT CONNACK, and the expected three AP-derived
  names after migration.
- The archived cloud source and static assets match
  `cloud-183/deployment/source-sha256.txt`.
