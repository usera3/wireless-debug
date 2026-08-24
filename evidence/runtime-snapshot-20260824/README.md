# Runtime Snapshot: 2026-08-24

This directory is the self-contained 2026-08-24 release. It keeps the exact
firmware source, ESP32-S3 flash package, editable web source, and the complete
host 183 cloud application together under one date.

## Contents

- [`firmware-source/`](firmware-source/): buildable firmware source from `2c548ac`
- [`firmware-flash/`](firmware-flash/): verified split images and complete 8 MB image
- [`web-source/`](web-source/): editable frontend source from `f8de108`
- [`cloud-183/`](cloud-183/): host 183 backend, deployment record, and deployed web assets

## Firmware

- Firmware source commit: `2c548ac` (`feature/elf-address-on-aug21-fw`)
- Firmware baseline: `6cb4de2` (`firmware-oled-ap-ssid-visible-20260818`)
- Tested frontend asset commit: `f8de108`
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
through the VNT SSH path. The prior directory was archived on the host before
replacement. The cloud Supervisor service remained running during deployment.

## Verification

- Frontend lint/build and the ELF/address-oscilloscope regressions passed.
- ESP-IDF 6.0 build completed with `Project build complete.`
- `full_flash_0x0.bin` is exactly 8 MB, and the board write plus readback
  verification completed successfully on COM4.
- The archived cloud source and static assets match
  `cloud-183/deployment/source-sha256.txt`.
