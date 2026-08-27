# ESP32-S3 Flash Package

Snapshot date: 2026-08-27. Build date: 2026-08-25.
Target: ESP32-S3 with 8 MiB flash, ESP-IDF 6.0.

This package was built from firmware commit `f3e705c`, based on the verified
2026-08-24 firmware commit `2c548ac`. It embeds web assets from frontend commit
`fd40805`. Snapshot commit `fc022fa` changes only the cloud Python upload path
and tests, so it does not require different firmware images.

The firmware keeps the OLED dynamic `AP:%s` SSID display and includes
memory-bounded `.out`/`.elf` structure and array indexing in the address
oscilloscope UI. Its cloud heartbeat also reports `ap_ssid` for AP-derived
default device names.

The application image is `0x19af60` bytes; the 0x280000-byte app partition
has `0xe50a0` bytes free.

The `f3e705c` package was written to COM4 and esptool verified every written
region. The complete image preserves the verified 8 MiB base outside the four
documented regions and overlays the matching split images. Region checks
confirm that all four regions in the complete image exactly match those files.

## Complete Flash

Use the WD-BootRelay controller to assert BOOT, press the main board's physical
RESET once, and prove that COM4 is in download mode. Then run
`flash_full_0x0.bat COM4` from this directory. Omit the port argument to use
`COM4`. Never flash the main firmware to the relay controller on COM7. The
complete image writes all 8 MiB at offset `0x0`.

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
