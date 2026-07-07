# wireless_debug

ESP32-S3 UART / BLE / WiFi wireless debug firmware.

The firmware provides UART transparent transmission over BLE SPP and WiFi WebSocket, an embedded Web UI, motor parameter tools, address oscilloscope, WiFi provisioning, and a 128x64 SSD1315 OLED menu controlled by two buttons.

## Current Hardware

| Item | Value |
|------|-------|
| Chip | ESP32-S3 |
| ESP-IDF | 6.0 |
| Flash | 8 MB |
| UART | UART1 |
| UART TX | GPIO10 |
| UART RX | GPIO9 |
| Default baud | 2 Mbps |
| OLED | SSD1315, 128x64, I2C |
| OLED SCL | GPIO19 |
| OLED SDA | GPIO20 |
| OLED I2C address | 0x3C |
| Button S4 | GPIO17, next item |
| Button S5 | GPIO18, short press OK, long press back |

The OLED hardware backend is enabled by default. The current board requires removing the bootloader jumper after flashing before the application can run normally.

## Web Entry

When the board starts in AP mode:

| Page | URL |
|------|-----|
| Main Web UI | `http://192.168.4.1/orig/i.html` |
| WiFi provisioning | `http://192.168.4.1/wifi.html` |
| WebSocket tunnel | `ws://192.168.4.1/ws` |

The root path redirects to `/orig/i.html`.

## Main Features

- UART transparent transmission through BLE or WiFi.
- BLE SPP service based on NimBLE.
- WiFi AP / STA mode switching.
- WiFi scan, quick connect, password provisioning page, and saved STA credentials in NVS.
- WebSocket binary UART tunnel.
- Runtime UART baud-rate switching.
- Embedded Web UI stored in SPIFFS.
- Address oscilloscope with history cache, channel visibility, wheel zoom, left-button drag, pause/review, CSV import/export, and mock waveform test entry.
- Motor diagnostic read/write APIs and parameter tools.
- OLED home screen showing WiFi, BLE, and UART status.
- OLED menu operated by S4/S5.
- Web/OLED state synchronization through the same action layer.
- Excel file upload/list/delete APIs.

## Project Layout

```text
wireless_debug-main/
├── main/
│   ├── app_core.*          # shared runtime state
│   ├── uart_transport.*    # UART driver, RX frame assembly, TX
│   ├── wifi_manager.*      # AP/STA mode, scan, connect, NVS credentials
│   ├── wifi_transport.*    # WebSocket UART tunnel
│   ├── ble_transport.*     # BLE SPP transport
│   ├── router_service.*    # UART/BLE/WiFi frame routing
│   ├── web_api.*           # HTTP control APIs
│   ├── web_static.*        # SPIFFS static file and Excel APIs
│   ├── display_port.*      # SSD1315 framebuffer/I2C backend
│   ├── display_lvgl.*      # LVGL display task
│   ├── display_ui.*        # OLED home/status pages
│   ├── system_menu.*       # OLED menu model
│   ├── ui_controller.*     # menu action execution
│   ├── input_buttons.*     # S4/S5 polling and debounce
│   ├── motor_diag.*        # motor diagnostic helpers
│   ├── comm_stats.*        # communication counters
│   └── health_reporter.*   # periodic health log
├── dist/
│   ├── index.html          # redirects to /orig/i.html
│   ├── wifi.html           # WiFi provisioning page
│   └── orig/               # bundled React Web UI
├── partitions.csv
├── sdkconfig
└── CMakeLists.txt
```

## Build

From WSL/Codex or a shell that can call the Windows ESP-IDF environment:

```bash
cmd.exe /C "cd /D D:\Users\sunqi39\Desktop\wireless_debug-main && C:\esp\v6.0\esp-idf\export.bat >nul 2>nul && idf.py build"
```

Expected output includes:

```text
Project build complete.
Generated D:/Users/sunqi39/Desktop/wireless_debug-main/build/uart_ble_wifi.bin
```

Flash from the project directory:

```bash
idf.py -p PORT flash
```

or use the generated `build/flash_args` file with `esptool`.

## Display Configuration

Current defaults are defined in `main/display_port.h`:

```c
#define CONFIG_ENABLE_DISPLAY 1
#define CONFIG_DISPLAY_BACKEND_VIRTUAL 0
#define CONFIG_DISPLAY_BACKEND_SSD1315 1
#define DISPLAY_WIDTH 128
#define DISPLAY_HEIGHT 64
#define DISPLAY_SSD1315_I2C_PORT 0
#define DISPLAY_SSD1315_SCL_GPIO 19
#define DISPLAY_SSD1315_SDA_GPIO 20
#define DISPLAY_SSD1315_I2C_ADDR 0x3C
#define DISPLAY_SSD1315_I2C_HZ 100000
#define DISPLAY_SSD1315_COLUMN_OFFSET 2
```

OLED behavior:

- Home page shows WiFi mode/IP, BLE on/off, and UART baud rate.
- S4 cycles menu items.
- S5 short press confirms.
- S5 long press returns.
- Operation results are shown as success/failure feedback.
- Long text is handled as a single-line clipped view with scrolling where needed.

## Partition Table

| Name | Type | Offset | Size | Purpose |
|------|------|--------|------|---------|
| `nvs` | data/nvs | `0x9000` | `0x6000` | NVS storage |
| `phy_init` | data/phy | `0xF000` | `0x1000` | PHY calibration |
| `factory` | app/factory | `0x10000` | `0x280000` | application firmware |
| `storage` | data/spiffs | `0x290000` | `0x570000` | Web UI, WiFi page, Excel files |

## HTTP API

Base URL in AP mode:

```text
http://192.168.4.1
```

Common endpoints:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/ws` | WebSocket | UART binary tunnel |
| `/api/device/status` | GET | device status |
| `/api/device/capabilities` | GET | API capabilities |
| `/api/system/health` | GET | health summary |
| `/api/comm/mode` | GET/POST | query or set comm mode |
| `/api/comm/stats` | GET/DELETE | read or reset communication counters |
| `/api/uart/baud` | GET/POST | query or set UART baud |
| `/api/uart/tx` | POST | send UART data |
| `/api/wifi/status` | GET | WiFi status |
| `/api/wifi/scan` | GET | scan nearby APs |
| `/api/wifi/connect` | POST | connect STA with SSID/password |
| `/api/wifi/sta` | POST/DELETE | save or clear STA credentials |
| `/api/wifi/mode` | POST | switch AP/STA mode |
| `/api/ws/status` | GET | WebSocket status |
| `/api/ble/status` | GET | BLE status |
| `/api/ble/start` | POST | start BLE |
| `/api/ble/tx` | POST | send BLE data |
| `/api/input/keys` | GET | key/action list |
| `/api/input/key` | POST | trigger a key action |
| `/api/menu/status` | GET | OLED menu state |
| `/api/display/status` | GET | display backend status |
| `/api/display/framebuffer` | GET | display framebuffer dump |
| `/api/display/text` | POST/DELETE | show or clear display text |
| `/api/display/scroll` | POST | show scrolling display text |
| `/api/motor/diag/capabilities` | GET | motor diagnostic capabilities |
| `/api/motor/diag/read` | POST | read motor diagnostic address |
| `/api/motor/diag/write` | POST | write motor diagnostic address |
| `/api/motor/osc/capabilities` | GET | oscilloscope capabilities |
| `/api/motor/osc/query` | POST | query oscilloscope settings |
| `/api/motor/osc/channel` | POST | configure oscilloscope channel |
| `/api/motor/osc/start` | POST | start oscilloscope sampling |
| `/api/motor/osc/stop` | POST | stop oscilloscope sampling |
| `/api/motor/osc/heartbeat` | POST | keep oscilloscope session alive |
| `/api/motor/osc/rate` | POST | set oscilloscope rate |
| `/api/motor/params` | GET/POST/DELETE | parameter table status/register/clear |
| `/api/motor/params/read` | POST | read registered parameter |
| `/api/motor/params/write` | POST | write registered parameter |
| `/api/excel/list` | GET | list uploaded Excel files |
| `/api/excel/upload` | POST | upload Excel file |
| `/api/excel/delete?name=...` | DELETE | delete Excel file |

## Version Anchor

Stable branch/tag used for the verified OLED and oscilloscope UI build:

```text
stable-osc-ui-20260707
```
