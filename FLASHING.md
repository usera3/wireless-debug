# ESP32-S3 Flash Files

This repository's current firmware flash package is here:

[`evidence/runtime-snapshot-20260824/firmware-flash/`](evidence/runtime-snapshot-20260824/firmware-flash/)

The same path in GitLab is:

```text
evidence/runtime-snapshot-20260824/firmware-flash/
```

## Recommended Full Flash

Download [`full_flash_0x0.bin`](evidence/runtime-snapshot-20260824/firmware-flash/full_flash_0x0.bin)
and write it at offset `0x0`.

On Windows, download the image and
[`flash_full_0x0.bat`](evidence/runtime-snapshot-20260824/firmware-flash/flash_full_0x0.bat),
put the board into download mode, then run:

```bat
flash_full_0x0.bat COM4
```

Omit `COM4` to use the default port. The image is an 8 MB ESP32-S3 image.

SHA-256:

```text
c87b3095f48811de799c70b23cf35d3fd81b0152ad32d2187dfef242fc7fedfb  full_flash_0x0.bin
```

## Split Images

The package also contains the four images used by ESP-IDF:

| Offset | File |
|---|---|
| `0x000000` | `bootloader.bin` |
| `0x008000` | `partition-table.bin` |
| `0x010000` | `uart_ble_wifi.bin` |
| `0x290000` | `storage.bin` |

See [`firmware-flash/README.md`](evidence/runtime-snapshot-20260824/firmware-flash/README.md)
for flash settings and checksum verification.
