# Runtime Snapshot: 2026-08-25

This directory is the self-contained 2026-08-25 release. It keeps the exact
firmware source, ESP32-S3 flash package, editable web source, and the complete
host 183 cloud application together under one date.

## Contents

- [`firmware-source/`](firmware-source/): buildable firmware source from `4148575`
- [`firmware-flash/`](firmware-flash/): verified split images and complete 8 MB image
- [`web-source/`](web-source/): editable frontend source from `22fb25a`
- [`cloud-183/`](cloud-183/): host 183 backend, deployment record, and deployed web assets
- [`ELF_ADDRESS_PICKER.md`](ELF_ADDRESS_PICKER.md): variable-name search and address-resolution design note

## Firmware

- Firmware source commit: `4148575` (`feature/elf-struct-array-index-20260825-fw`)
- Direct firmware parent: `2c548ac` (the verified 2026-08-24 snapshot source)
- OLED/AP-name baseline: `6cb4de2` (`firmware-oled-ap-ssid-visible-20260818`)
- Tested frontend asset commit: `22fb25a`
- Target: ESP32-S3, 8 MB flash, DIO, 80 MHz
- Application image: `0x19af40` bytes, with about `0xe50c0` bytes free in the app partition

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
Its static assets were deployed to `/apps/svr/wireless-debug-cloud/dist/orig`
through the VNT SSH path. The previous runtime was backed up as
`/apps/backups/wireless-debug-cloud/pre-static-20260825T153459.tar.gz`; only
the `cloud` Supervisor program was restarted. Mosquitto and PostgreSQL were not
restarted.

## Verification

- Frontend lint/build, parser/UI regressions, and desktop/mobile Playwright
  acceptance passed for TI C2000 and IAR fixtures.
- ESP-IDF 6.0 build completed with `Project build complete.`
- `full_flash_0x0.bin` is exactly 8 MB and contains the split images at their
  documented offsets. COM4 was flashed, then all four flash regions passed an
  independent esptool readback with `digest matched`.
- The restarted board reported `HEALTH OK`, advertised `ESP32-S3_AP_7C9D`,
  served the expected `a.js` SHA-256, and passed the same Playwright ELF picker
  acceptance directly at `http://192.168.4.1/orig/i.html`.
- The archived cloud source and static assets match
  `cloud-183/deployment/source-sha256.txt`.
