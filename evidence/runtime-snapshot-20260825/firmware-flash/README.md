# ESP32-S3 Flash Package

Build date: 2026-08-25. Target: ESP32-S3 with 8 MB flash, ESP-IDF 6.0.

This package was built from firmware commit `4148575`, whose direct parent is
the verified 2026-08-24 firmware commit `2c548ac`. It embeds web assets from
frontend commit `22fb25a`. The firmware keeps the OLED dynamic `AP:%s` SSID
display and includes memory-bounded `.out`/`.elf` structure and array indexing
in the address-oscilloscope UI.

The application image is `0x19af40` bytes; the 0x280000-byte app partition
has `0xe50c0` bytes free.

The 2026-08-25 COM4 installation was followed by an independent esptool
`verify-flash` of all four regions. The bootloader, partition table,
application, and complete `0x570000`-byte storage partition all reported
`Verification successful (digest matched)`.

## Complete Flash

Use the WD-BootRelay controller to assert BOOT, press the main board's physical
RESET once, and prove that COM4 is in download mode. Then run
`flash_full_0x0.bat COM4` from this directory. Omit the port argument to use
`COM4`. Never flash the main firmware to the relay controller on COM7. The
complete image writes all 8 MB at offset `0x0`.

## Split Flash

```text
0x000000  bootloader.bin
0x008000  partition-table.bin
0x010000  uart_ble_wifi.bin
0x290000  storage.bin
```

Flash settings are DIO, 80 MHz, 8 MB, and 460800 baud. After flashing, release
the relay to RUN and reset through the reachable flasher stub. Finish with
`GPIO14=HIGH RELAY=OFF`.

Verify the package with:

```bash
sha256sum -c SHA256SUMS
```

`esp_websocket_client_tx_diagnostics.patch` documents the component patch
already applied while building this image. It is included so a clean rebuild
can reproduce the same component API.
