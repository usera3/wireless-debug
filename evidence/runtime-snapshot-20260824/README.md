# Runtime Snapshot: 2026-08-24

This snapshot records the current firmware source, the ESP32-S3 flash package
written to the board, frontend source, and the static web runtime deployed to
host 183.

## Firmware

- Firmware source tree baseline: `cf09701` (`final-hardening-20260715`)
- Flash build firmware baseline: `6cb4de2` (`firmware-oled-ap-ssid-visible-20260818`)
- Tested frontend asset commit: `f8de108`
- Target: ESP32-S3, 8 MB flash, DIO, 80 MHz
- Application image: `0x19af40` bytes, with about `0xe50c0` bytes free in the app partition

The complete image is in
[`firmware-flash/full_flash_0x0.bin`](firmware-flash/full_flash_0x0.bin) and
must be written at offset `0x0`. Verify all package files with
[`firmware-flash/SHA256SUMS`](firmware-flash/SHA256SUMS).

## Frontend

The source snapshot is under
[`../../frontend-runtime-20260824/`](../../frontend-runtime-20260824/). The
generated browser assets are stored in the root `dist/orig/` directory and in
the embedded firmware `storage.bin`.

## Host 183

The same static assets were deployed to
`/apps/svr/wireless-debug-cloud/dist/orig` through the VNT SSH path. The prior
directory was archived on the host before replacement. The cloud Supervisor
service remained running during deployment.

## Verification

- Frontend lint/build and the ELF/address-oscilloscope regressions passed.
- ESP-IDF 6.0 build completed with `Project build complete.`
- `full_flash_0x0.bin` is exactly 8 MB, and the board write plus readback
  verification completed successfully on COM4.
