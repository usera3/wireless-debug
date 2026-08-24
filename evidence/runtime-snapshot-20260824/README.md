# Runtime Snapshot: 2026-08-24

This snapshot records the current firmware source, generated ESP32-S3 flash
package, frontend source, and the static web runtime deployed to host 183.

## Firmware

- Firmware source branch: `final-hardening-20260715`
- Firmware source commit: `cf09701`
- Frontend source commit: `da2daf0`
- Target: ESP32-S3, 8 MB flash, DIO, 80 MHz
- Application image: `0xd8500` bytes free in the app partition (34%)

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

- Frontend `npm run lint` completed with no errors (existing React Hook
  warnings remain).
- Frontend production `npm run build` completed successfully.
- Oscilloscope runtime, connection-status resilience, ELF parser, oscilloscope
  request, and oscilloscope transport regressions passed.
- ESP-IDF 6.0 build completed with `Project build complete.`
- `full_flash_0x0.bin` is exactly 8 MB and includes the refreshed SPIFFS image.

The attempted COM4 flash was not completed because the device returned no
ESP32-S3 download handshake; no claim of hardware programming is made here.
