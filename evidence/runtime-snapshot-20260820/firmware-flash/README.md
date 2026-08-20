# ESP32-S3 Flash Package

Target: ESP32-S3 with 8 MB flash.

## Complete flash

Put the board into download mode and flash this one file at offset `0x0`:

```text
full_flash_0x0.bin
```

On Windows, run `flash_full_0x0.bat COM4` from this directory. Omit the port
argument to use `COM4`.

The complete image is exactly 8 MB and contains the following data at the
standard offsets:

| Offset | Image | Purpose |
|---|---|---|
| `0x000000` | `bootloader.bin` | Bootloader |
| `0x008000` | `partition-table.bin` | Partition table |
| `0x010000` | `uart_ble_wifi.bin` | Application |
| `0x290000` | `storage.bin` | SPIFFS web assets and data |

## Split flash

The equivalent split command is:

```text
bootloader.bin       @ 0x000000
partition-table.bin  @ 0x008000
uart_ble_wifi.bin     @ 0x010000
storage.bin           @ 0x290000
```

Flash settings are DIO, 80 MHz, 8 MB, and 460800 baud. After flashing, remove
the download-mode jumper if fitted and reset the board before normal startup.

Run the checksum verification from this directory:

```bash
sha256sum -c SHA256SUMS
```
