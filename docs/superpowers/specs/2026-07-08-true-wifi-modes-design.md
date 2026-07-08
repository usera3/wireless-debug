# True WiFi Modes Design

## Goal

Expose three real WiFi driver modes on the OLED menu: AP, STA, and APSTA.
The default boot mode remains APSTA.

## Mode Semantics

AP mode means the driver is actually `WIFI_MODE_AP`.
The ESP32 hotspot and `http://192.168.4.1` are available.
External router connection is not active.

STA mode means the driver is actually `WIFI_MODE_STA`.
The ESP32 hotspot is off, so `http://192.168.4.1` is not available.
STA quick connection can finish in true STA because it uses the STA radio directly.
STA web setup must temporarily keep or enter APSTA while setup is in progress, then close AP after STA connects successfully.
The selected target mode remains STA during that setup process.

APSTA mode means the driver is actually `WIFI_MODE_APSTA`.
The ESP32 hotspot remains available while STA scan and connection are available.
This is the normal default mode and the safest mode for web setup.
WiFi scan keeps the verified 150 ms home-channel dwell.

## STA Link State

The selected WiFi mode and the STA link state are separate concepts.

Selected mode:

- AP
- STA
- APSTA

STA link state:

- not configured
- connecting
- connected
- lost
- retrying

STA disconnects must not silently change the selected WiFi mode.
If the user selected STA, the device stays in STA and retries STA.
If the user selected APSTA, the device stays in APSTA, keeps the ESP32 AP online, and retries STA.
If the user selected AP, STA disconnects are irrelevant.

## OLED Behavior

The Network menu shows AP Mode, STA Mode, and APSTA Mode as the only top-level mode items.
The active item is marked ON.

AP Mode has no child workflow.
Selecting AP Mode immediately switches to true AP mode.

STA Mode opens a child page with exactly two actions:

- Quick Connect
- Web Setup

STA Quick Connect scans WiFi on the OLED, lets the user choose an SSID, and uses the existing quick-connect rule:
if the SSID matches the saved STA config, use the saved password; otherwise use the default password `12345678` and save it after a successful connection.
After a successful STA Quick Connect, the device switches to true STA and closes AP.

STA Web Setup starts a provisioning workflow whose target mode is STA.
Because web setup needs the ESP32 AP and web server, the firmware keeps or enters APSTA while the user configures WiFi from the browser.
After the web-configured STA connection succeeds, the firmware switches to true STA and closes AP.

APSTA Mode opens a child page with exactly two actions:

- Quick Connect
- Web Setup

APSTA Quick Connect uses the same OLED scan and quick-connect rule as STA Quick Connect, but the device remains true APSTA after connection.
APSTA Web Setup keeps or switches to true APSTA and leaves AP/web available after connection.

The OLED closed home view shows the selected mode and the useful IP for that mode:

- AP: `WiFi:AP`, `IP:192.168.4.1`
- STA connected: `WiFi:STA`, `IP:<sta_ip>`
- STA not connected: `WiFi:STA`, `IP:-`
- APSTA with STA connected: `WiFi:APSTA`, `IP:<sta_ip>`
- APSTA without STA connected: `WiFi:APSTA`, `IP:192.168.4.1`

## Web Behavior

Web setup is available only when AP is on, meaning AP or APSTA mode.
Pure STA mode disables the ESP32 hotspot and therefore disables web setup until the user switches back by OLED or starts the STA Web Setup workflow from OLED.

The web API may expose mode values `ap`, `sta`, and `apsta`.
Requests from web clients to switch into pure STA may disconnect that web client immediately.
When web setup is launched from the STA Mode child page, the requested target mode is STA even though the temporary driver mode is APSTA during provisioning.

## Failure Handling

Initial STA connection failure in STA mode stays in STA and reports `STA FAIL` or `STA RETRY`.
Initial STA connection failure in APSTA mode stays in APSTA and reports `STA FAIL` while AP remains usable.

STA Web Setup failure leaves the device in APSTA so the user can keep using the web setup page and retry.
The selected target mode remains STA until the user chooses another mode or cancels setup.

Lost STA connection in STA mode reports `STA LOST` and retries saved credentials.
Lost STA connection in APSTA mode reports `STA LOST` and retries saved credentials while AP remains usable.

The firmware must not fall back from STA to AP automatically unless a future user setting explicitly enables that behavior.

## Known Hardware Result

The AP-to-APSTA scan experiment failed on this device.
Switching the driver from true AP to APSTA during scan caused Windows to disconnect from the ESP32 hotspot.
Therefore, stable web scanning should use APSTA from the start, not AP followed by APSTA promotion.
