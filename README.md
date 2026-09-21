# wireless_debug

ESP32-S3 UART / BLE / WiFi wireless debug firmware.

The firmware provides UART transparent transmission over BLE SPP and WiFi WebSocket, an embedded Web UI, motor parameter tools, address oscilloscope, WiFi provisioning, and a 128x64 SSD1315 OLED menu controlled by two buttons.

The `oled-smooth-ui-20260730` branch is the hardware-verified checkpoint for
continuous local/cloud oscilloscope transport and smooth LVGL OLED menu motion.
The `wifi-provisioning-fix-20260803` branch builds on that checkpoint with the
WiFi provisioning and SoftAP continuity fixes documented below.

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
| OLED SCL | GPIO4 |
| OLED SDA | GPIO5 |
| OLED I2C address | 0x3C |
| Button S4 | GPIO17, next item |
| Button S5 | GPIO18, short press OK, long press back |
| Native USB D- | GPIO19, fixed by ESP32-S3 |
| Native USB D+ | GPIO20, fixed by ESP32-S3 |

The OLED hardware backend is enabled by default. The current board requires removing the bootloader jumper after flashing before the application can run normally.

## Web Entry

USB NCM and WiFi SoftAP share one local bridge. Either connection reaches the
same URLs; no Web UI mode selector is required:

| Page | URL |
|------|-----|
| Main Web UI | `http://192.168.4.1/orig/i.html` |
| WiFi provisioning | `http://192.168.4.1/wifi.html` |
| WebSocket tunnel | `ws://192.168.4.1/ws` |

The root path redirects to `/orig/i.html`.

### USB and OLED wiring on ESP32-S3 DevKit

- Connect the PC data cable to the board's native USB/OTG connector for NCM.
- Keep the USB-UART connector (or an external USB-UART adapter) for flashing and logs.
- Move OLED SCL from GPIO19 to GPIO4.
- Move OLED SDA from GPIO20 to GPIO5.
- OLED VCC and GND do not change.

GPIO19/20 cannot be shared with the OLED because the ESP32-S3 internal USB PHY
fixes those pins as D-/D+. Windows uses its inbox NCM driver through the
firmware's Microsoft OS 2.0 descriptor.

The bridge alone owns `192.168.4.1/24` and the DHCP server. Its USB and SoftAP
ports have no separate IP address, while WiFi STA remains an independent cloud
uplink. The local DHCP server publishes no default gateway, so connecting the
board does not replace the PC's normal Internet route. ESP-IDF advertises the
bridge itself as DNS; a small proxy forwards requests through the cloud STA
when available and fails fast when there is no upstream DNS.

## WiFi Scan Stability

The WiFi provisioning page scans nearby APs while the PC is connected to the ESP32 SoftAP.
Because ESP32-S3 has one WiFi radio, a full-channel scan leaves the SoftAP channel between
channels. If the home-channel dwell is too short, Windows may stop receiving ESP32 AP beacons
and disconnect from the ESP32 hotspot during the scan.

The verified stable approach is:

- Keep the driver in `WIFI_MODE_APSTA` even when the logical UI mode is AP-only.
- Do not switch `WIFI_MODE_AP` -> `WIFI_MODE_APSTA` only for scanning, because that mode
  transition itself can make clients reconnect.
- Use short active scan windows, currently 10-30ms per channel.
- Use `home_chan_dwell_time = 150ms`, the ESP-IDF allowed maximum, so the radio returns to
  the SoftAP channel long enough for clients to keep receiving beacons.

Current boot behavior uses `WIFI_MANAGER_START_STA_ON_BOOT=1`; when STA config exists, the
logical mode starts as STA/APSTA. If the product later defaults to logical AP mode, keep the
underlying driver in APSTA from startup with STA idle. Starting in true AP-only mode and
switching to APSTA at scan time is less stable and should be avoided unless a one-time client
reconnect is acceptable.

## Main Features

- UART transparent transmission through BLE or WiFi.
- BLE SPP service based on NimBLE.
- WiFi AP / STA uplink mode switching while the local SoftAP remains available.
- Native USB NCM and WiFi SoftAP access through the same `192.168.4.1` bridge.
- WiFi scan, quick connect, password provisioning page, and saved STA credentials in NVS.
- WebSocket binary UART tunnel.
- Runtime UART baud-rate switching.
- Embedded Web UI stored in SPIFFS.
- Address oscilloscope with history cache, channel visibility, wheel zoom, left-button drag, pause/review, CSV import/export, and mock waveform test entry.
- Lossless compressed cloud oscilloscope uplink with pacing and reconnect buffering for continuous waveform delivery.
- Motor diagnostic read/write APIs and parameter tools.
- OLED home screen showing WiFi, BLE, and UART status.
- OLED menu operated by S4/S5, with an animated selection cursor and directional page transitions.
- Web/OLED state synchronization through the same action layer.
- Excel file upload/list/delete APIs.

## Project Layout

```text
wireless_debug-main/
├── main/
│   ├── app_core.*          # shared runtime state
│   ├── uart_transport.*    # UART driver, RX frame assembly, TX
│   ├── wifi_manager.*      # AP/STA mode, scan, connect, NVS credentials
│   ├── local_access_bridge.* # USB NCM + SoftAP bridge and DHCP owner
│   ├── local_dns_proxy.*   # DNS forwarding through the active cloud STA
│   ├── usb_ncm_windows.*   # Windows WINNCM descriptors
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

## Repository workflow

`standard/main` is the future clean source base. Read the
[repository policy](docs/REPOSITORY_POLICY.md) and
[baseline provenance](docs/BASELINE_PROVENANCE.md), then create feature branches from
`standard/main`. Publish release artifacts through the external release workflow,
not Git: do not create `runtime-snapshot-*` refs or directories for releases.

## Build

From the root of the checkout you intend to build, use WSL/Codex or another shell
that can call the Windows ESP-IDF environment. The Windows command inherits the
current checkout directory, so it also works from a feature worktree:

```bash
cmd.exe /D /S /C "call C:\esp\v6.0\esp-idf\export.bat >nul 2>nul && idf.py reconfigure"
```

Apply the tracked WebSocket diagnostics patch whenever `managed_components/` is
created or refreshed, then build with bounded Windows toolchain concurrency:

```bash
patch -p1 -d managed_components/espressif__esp_websocket_client \
  < patches/esp_websocket_client_tx_diagnostics.patch
cmd.exe /D /S /C "call C:\esp\v6.0\esp-idf\export.bat >nul 2>nul && ninja -C build -j4"
```

The patch command should report two patched files. A successful build exits 0 and
includes output like:

```text
Generated <current-checkout>/build/uart_ble_wifi.bin
```

See [the managed-component patch notes](patches/README.md) for the pinned component
hash. The `-j4` limit avoids intermittent Windows process-launch failures observed
with this ESP 15.2 toolchain at Ninja's default high concurrency.

Flash from the project directory:

```bash
idf.py -p PORT flash
```

or use the generated `build/flash_args` file with `esptool`.

For the cloud-PC development and local flashing workflow, see:

```text
docs/CLOUD_LOCAL_WORKFLOW.md
docs/CLOUD_CODEX_USAGE.md
```

## Display Configuration

Current defaults are defined in `main/display_port.h`:

```c
#define CONFIG_ENABLE_DISPLAY 1
#define CONFIG_DISPLAY_BACKEND_VIRTUAL 0
#define CONFIG_DISPLAY_BACKEND_SSD1315 1
#define DISPLAY_WIDTH 128
#define DISPLAY_HEIGHT 64
#define DISPLAY_SSD1315_I2C_PORT 0
#define DISPLAY_SSD1315_SCL_GPIO 4
#define DISPLAY_SSD1315_SDA_GPIO 5
#define DISPLAY_SSD1315_I2C_ADDR 0x3C
#define DISPLAY_SSD1315_I2C_HZ 400000
#define DISPLAY_SSD1315_COLUMN_OFFSET 2
```

OLED behavior:

- Home page shows WiFi mode/IP, BLE on/off, and UART baud rate.
- S4 cycles menu items.
- S5 short press confirms.
- S5 long press returns.
- Operation results are shown as success/failure feedback.
- Long text is handled as a single-line clipped view with scrolling where needed.
- The selection cursor moves with a 200ms ease-out animation and inverts the
  underlying monochrome pixels using LVGL difference blending.
- Home, menu, submenu, and overlay transitions slide 24 pixels in the navigation
  direction over 200ms.
- The LVGL task follows the timer handler with a bounded 5-20ms wake interval.
- SSD1315 transfers use 400kHz I2C and batch one 128-byte display page per write.

## 2026-07-30 Stable Checkpoint

| Item | Value |
|------|-------|
| Branch | `oled-smooth-ui-20260730` |
| Hardware-verified firmware tag | `stable-oled-smooth-ui-20260730` |
| Firmware commit | `80ad0d4f58fe3cf27d97cf59076777251f17a187` |
| Target | ESP32-S3, 8MB flash, SSD1315 128x64 OLED |
| Application image | `0x199aa0` bytes, 36% of the app partition free |

This checkpoint was built with ESP-IDF 6.0 and verified on the physical device.
The selection cursor, forward/back page transitions, normal boot, local Web UI,
and cloud oscilloscope path were exercised on hardware. The OLED motion, I2C
speed, layout, and WiFi status regression scripts also passed.

The recovery material is not stored on this clean source branch. Preserved
historical material remains in the `runtime-snapshot-20260827` ref at
`fab0f6c58bc675af86085614ebd1c1583bc2cc57`; use that historical ref when it is
needed, or follow the external release workflow for published artifacts.

For a complete restore, enter download mode and run the following command from
the extracted `flash` directory after replacing `PORT` with the actual serial
port:

```bash
python -m esptool --chip esp32s3 -p PORT -b 460800 \
  --before default-reset --after hard-reset \
  write-flash "@flash_args"
```

The stable tag remains attached to the exact historical firmware source used for
the archived binaries. This independent clean baseline records that provenance
without inheriting the historical branch topology.

Known cosmetic edge: immediately reversing a forward page transition during its
200ms animation can let the returning content finish in the original direction.
Normal physical-button operation did not expose a jump or crash.

## 2026-08-03 WiFi Provisioning Fixes

This branch keeps the 2026-07-30 OLED and oscilloscope baseline and adds a
hardware-verified fix for the WiFi provisioning workflow. The changes address
the connection-status delay and SoftAP disruption seen when the browser submits
STA credentials; they do not change the oscilloscope sample format or waveform
rendering path.

| Item | Ref |
|------|-----|
| August fix branch | `wifi-provisioning-fix-20260803` |
| Comparison branch and previous tip | `oled-smooth-ui-20260730` at `b3b3b23` |
| WiFi status delivery fix | `3f40dd5` |
| SoftAP-preserving reconnect fix | `a342545` |

Compared with the 2026-07-30 baseline:

- The browser no longer has to wait tens of seconds (and sometimes up to a
  minute or more) after the OLED already reports that STA has connected. The
  firmware now exposes a dedicated `/ws/wifi-status` WebSocket, sends an
  immediate status snapshot, and publishes subsequent state changes.
- The provisioning page uses the WebSocket as its primary status path and a
  sequential, short-timeout HTTP poll as a fallback. Poll generations prevent
  late responses from an earlier connection attempt from overwriting the
  current result, and polling stops as soon as `sta_connected` is reported.
- When the device is already running APSTA, reconnecting STA credentials now
  disconnects and reconfigures only the STA interface in place. It no longer
  needlessly reapplies APSTA mode or rewrites the SoftAP configuration, which
  avoids invalidating the browser's existing connection to `192.168.4.1`.
- The browser's success/failure state is now driven by the same firmware WiFi
  state callback that updates the OLED and cloud transports, instead of relying
  only on a delayed HTTP observation.

The earlier scan-stability work from the July 31 branch tip remains in place:
APSTA mode is preserved during scans, scans are suppressed while an AP client
is active, and the SoftAP home-channel dwell is bounded for reliable beacons.

Verification for this increment:

```text
node scripts/wifi_page_regression.mjs
node scripts/wifi_status_push_regression.mjs
python3 scripts/wifi_apsta_reconnect_regression.py
node scripts/wifi_true_modes_regression.mjs
git diff --check
ninja -C build-wifi-status -j 8
```

All listed regressions passed. The resulting firmware was flashed and checked
on an ESP32-S3: the device came up in APSTA mode, both AP and STA HTTP endpoints
returned 200, the status WebSocket delivered its initial snapshot immediately,
and the board's `wifi.html` and `orig/a.js` matched the local SPIFFS sources.

## Partition Table

| Name | Type | Offset | Size | Purpose |
|------|------|--------|------|---------|
| `nvs` | data/nvs | `0x9000` | `0x6000` | NVS storage |
| `phy_init` | data/phy | `0xF000` | `0x1000` | PHY calibration |
| `factory` | app/factory | `0x10000` | `0x280000` | application firmware |
| `storage` | data/spiffs | `0x290000` | `0x570000` | Web UI, WiFi page, Excel files |

## HTTP API

Base URL over either WiFi SoftAP or native USB NCM:

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
| `/api/wifi/scan` | GET | scan nearby APs, returns scan timing fields |
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

## Version Anchors

| Purpose | Ref |
|---------|-----|
| August WiFi provisioning branch | `wifi-provisioning-fix-20260803` |
| July 30 OLED baseline branch | `oled-smooth-ui-20260730` |
| Hardware-verified OLED firmware | `stable-oled-smooth-ui-20260730` |
| Verified oscilloscope pacing baseline | `stable-osc-pacing-20260730` |
| Verified WiFi provisioning fix | `a342545` (includes `3f40dd5`) |
| Previous OLED/oscilloscope baseline | `stable-osc-ui-20260707` |
