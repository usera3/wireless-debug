# ESP32-S3 Flash Package

Build date: 2026-08-24. Target: ESP32-S3 with 8 MB flash, ESP-IDF 6.0.

This package was built from firmware baseline `6cb4de2` (the 2026-08-21
runtime) with its checked-in WebSocket diagnostics patch applied, and the web
assets from frontend commit `f8de108`. The firmware keeps the OLED dynamic
`AP:%s` SSID display and includes the memory-bounded `.out`/`.elf` variable
address picker in the embedded web UI.

The application image is `0x19af40` bytes; the 0x280000-byte app partition
has `0xe50c0` bytes free.

## Complete Flash

Put the board into download mode and run `flash_full_0x0.bat COM4` from this
directory. Omit the port argument to use `COM4`. The complete image writes all
8 MB at offset `0x0`.

## Split Flash

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

`esp_websocket_client_tx_diagnostics.patch` documents the component patch
already applied while building this image. It is included so a clean rebuild
can reproduce the same component API.
