# ESP32-S3 Flash Package

Build date: 2026-08-24. Target: ESP32-S3 with 8 MB flash, ESP-IDF 6.0.

The package contains the firmware application and the web assets built from
frontend commit `da2daf0`. The application image has `0xd8500` bytes (34%) of
the app partition free.

## Complete flash

Put the board into download mode and flash `full_flash_0x0.bin` at offset
`0x0`. On Windows, run `flash_full_0x0.bat COM4` from this directory. Omit the
port argument to use `COM4`.

## Split flash

```text
0x000000  bootloader.bin
0x008000  partition-table.bin
0x010000  uart_ble_wifi.bin
0x290000  storage.bin
```

Flash settings are DIO, 80 MHz, 8 MB, and 460800 baud. Remove the download
mode jumper after flashing and reset the board before normal startup.

Verify the package with:

```bash
sha256sum -c SHA256SUMS
```
