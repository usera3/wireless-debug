# Remote MQTT Status And Control Design

Date: 2026-07-08

## Goal

Build a first remote-access MVP for `wireless_debug` so a user can view ESP32 status and send basic configuration/control commands without being on the ESP32 local AP or LAN.

The first version runs the cloud side locally on the developer PC. The same service layout should later deploy to an Ubuntu cloud server with minimal changes: copy the service directory, install Docker, expose ports, and change the ESP32 MQTT host from the local PC IP to the cloud server IP or domain.

## Scope

Included in this MVP:

- Single device, fixed default `device_id` such as `esp32-001`.
- Local Docker Compose stack with Mosquitto and a small Node.js web service.
- ESP32 connects outward to MQTT when STA is online.
- Browser connects to the Node.js web service, not directly to ESP32.
- Browser can view current/last device status.
- Browser can send remote commands through the Node.js service.
- Node.js service records command status in memory.
- No login, no TLS, no per-device secret in the first version.

Not included in this MVP:

- Remote UART passthrough.
- Multi-user permissions.
- Cloud database.
- Device fleet management.
- Public internet hardening.
- Replacing the existing local AP web UI.

## Recommended Architecture

Use the simplest self-hosted relay:

```text
ESP32 STA/APSTA
    |
    | MQTT tcp://<pc-or-server-ip>:1883
    v
Mosquitto
    |
    | MQTT subscribe/publish
    v
Node.js remote service
    |
    | HTTP + SSE
    v
Browser remote page
```

Mosquitto is only the message broker. Node.js owns the browser API, current device cache, command IDs, ACK tracking, and the remote page.

This avoids exposing ESP32 directly to the internet and keeps NAT traversal simple because ESP32 only makes outbound MQTT connections.

## Alternatives Considered

1. Mosquitto plus Node.js, recommended.
   - Fast to run locally.
   - Easy to move to Ubuntu.
   - Keeps device protocol and browser protocol separate.
   - Enough for status and configuration/control.

2. EMQX plus Node.js.
   - Better broker dashboard and future fleet features.
   - Heavier than needed for one-device MVP.

3. Cloud IoT platform.
   - Good long-term security and fleet management.
   - Slower first bring-up because certificates, product models, rules, and platform-specific APIs must be configured before the basic demo works.

## Local Service Layout

Add the service under the firmware repo so it can be versioned with firmware protocol changes:

```text
tools/remote_mqtt/
  docker-compose.yml
  mosquitto/
    mosquitto.conf
  server/
    package.json
    src/
      index.js
    public/
      index.html
```

Local ports:

- MQTT broker: `1883`
- Remote web page/API: `3000`

Mosquitto must listen on `0.0.0.0:1883`, not only `localhost`, because ESP32 needs to reach it through the PC's LAN IP. Windows firewall may need an allow rule for port `1883`.

## MQTT Topics

Use one topic namespace:

```text
wireless-debug/<device_id>/status
wireless-debug/<device_id>/availability
wireless-debug/<device_id>/cmd
wireless-debug/<device_id>/ack
```

Status:

- ESP32 publishes retained status snapshots to `status`.
- Publish interval: every 5 seconds while MQTT is connected.
- Also publish immediately after WiFi state changes, UART baud changes, comm mode changes, or command completion.

Availability:

- ESP32 publishes `online` after MQTT connection.
- MQTT last will publishes `offline` when the broker detects disconnect.
- Node.js uses availability plus status timestamp to decide whether the device is online.

Commands:

- Node.js publishes commands to `cmd`.
- ESP32 subscribes to `cmd`.
- Commands are JSON and include a unique `command_id`.

ACK:

- ESP32 publishes command result to `ack`.
- Node.js updates in-memory command state and pushes it to browser clients.

## Payloads

Status payload:

```json
{
  "device_id": "esp32-001",
  "fw": "wireless-debug",
  "uptime_ms": 123456,
  "net_mode": "apsta",
  "sta_configured": true,
  "sta_connecting": false,
  "sta_connected": true,
  "ap_ip": "192.168.4.1",
  "sta_ip": "192.168.1.23",
  "uart_baud": 2000000,
  "comm_mode": "auto",
  "ble_ready": true,
  "ble_subscribed": false,
  "wifi_ws_client": false
}
```

Command payload:

```json
{
  "command_id": "cmd-000001",
  "type": "set_wifi_mode",
  "args": {
    "mode": "apsta"
  }
}
```

ACK payload:

```json
{
  "device_id": "esp32-001",
  "command_id": "cmd-000001",
  "ok": true,
  "type": "set_wifi_mode",
  "message": "queued"
}
```

If a command fails validation or cannot be applied, `ok` is false and `message` contains a short reason.

## First Commands

Implement only commands that map cleanly to existing firmware behavior:

- `query_status`: publish a fresh status snapshot.
- `set_wifi_mode`: `ap`, `sta`, `apsta`.
- `set_uart_baud`: numeric baud within existing UART limits.
- `set_comm_mode`: `auto`, `wifi`, `ble`.
- `ble_start`: start BLE advertising/service.
- `display_text`: show short text on OLED using the existing display text path.

Defer motor diagnostics and remote UART passthrough until the status/control path is stable.

## Firmware Design

Add a small `cloud_mqtt` module rather than putting MQTT logic into `main.c` or `web_api.c`.

Proposed files:

```text
main/cloud_mqtt.h
main/cloud_mqtt.c
```

Responsibilities:

- Start only after WiFi manager reports STA connected.
- Stop or stay disconnected when in pure AP mode or when STA is offline.
- Connect to configured MQTT broker.
- Publish status and availability.
- Subscribe to command topic.
- Parse command JSON.
- Call existing control functions or callbacks for WiFi mode, UART baud, comm mode, BLE start, display text, and status query.
- Publish ACK for every valid command received.

The module should use existing state sources instead of duplicating logic:

- `wifi_manager_get_status`
- `system_menu_get_state`
- `app_core_get_mode` or existing system menu state for comm mode
- existing BLE state functions
- existing display text functions
- existing UART baud setters

ESP-IDF dependency:

- Use ESP-IDF MQTT client (`mqtt_client.h`).
- Add the MQTT component to `main/CMakeLists.txt` if the build requires it.

## Firmware Configuration

For fastest bring-up, compile defaults are acceptable:

```text
device_id = esp32-001
mqtt_uri = mqtt://<developer-pc-lan-ip>:1883
enabled = true
```

The first implementation should keep these defaults in one place, preferably in `cloud_mqtt.c` constants or Kconfig defaults. Do not hard-code passwords or tokens.

A later iteration can add web/OLED configuration for MQTT host, port, enable/disable, and device ID.

## Browser/Server Design

Node.js service responsibilities:

- Connect to Mosquitto as an MQTT client.
- Subscribe to `wireless-debug/+/status`, `availability`, and `ack`.
- Keep an in-memory map of devices by `device_id`.
- Provide a browser page at `/`.
- Provide JSON APIs:
  - `GET /api/devices`
  - `GET /api/devices/:id/status`
  - `POST /api/devices/:id/command`
- Provide realtime updates through SSE at `/events`.
- Generate `command_id` values.
- Track pending commands and mark them failed after a timeout, recommended 8 seconds.

The page should be a practical dashboard:

- Device online/offline.
- Last status time.
- WiFi mode and STA connection state.
- AP IP and STA IP.
- UART baud.
- Communication mode.
- BLE state.
- Buttons/selectors for the first command set.
- Command result log.

## Mode Behavior

Remote access depends on STA connectivity:

- AP mode: local-only mode. ESP32 will not be reachable by MQTT unless it is separately connected by some other network path, which this MVP does not support.
- STA mode: remote works when STA is connected.
- APSTA mode: remote works when STA is connected; AP remains available locally at `192.168.4.1`.

If STA disconnects, ESP32 keeps normal WiFi reconnect behavior. MQTT should reconnect automatically only after STA is connected again. The remote page should show the device offline or stale rather than pretending commands were applied.

## Error Handling

ESP32:

- Invalid JSON command: publish `ack` with `ok:false`.
- Unknown command type: publish `ack` with `ok:false`.
- Command not allowed in current state: publish `ack` with `ok:false`.
- MQTT disconnect: retry with backoff handled by the MQTT client or a small reconnect timer.
- STA disconnect: stop sending status until MQTT reconnects.

Node.js:

- Device has no recent status: show offline/stale.
- Command sent while offline: reject immediately.
- Command ACK timeout: mark failed.
- MQTT broker disconnect: show server broker status as disconnected and reject new commands until reconnected.

## Testing

Local server:

- `docker compose up` starts Mosquitto and Node.js.
- Browser opens `http://localhost:3000`.
- A small mock-device script can publish sample status and respond to commands before firmware is flashed.

Firmware source regression:

- Check MQTT topic constants.
- Check command type strings.
- Check no token/password is committed.
- Check pure AP mode does not claim cloud connectivity.

Firmware build:

- Run the existing ESP-IDF build command after adding `cloud_mqtt`.

Hardware test:

1. Start local Mosquitto and Node.js.
2. Put ESP32 in APSTA or STA mode and connect it to the same LAN as the PC.
3. Configure or compile MQTT URI to the PC LAN IP.
4. Open `http://localhost:3000`.
5. Verify status updates every 5 seconds.
6. Send `query_status`, `set_uart_baud`, `set_comm_mode`, `ble_start`, and `display_text`.
7. Verify ACKs appear in the browser and the local OLED/web status matches.
8. Switch to AP mode and verify the remote page reports offline/stale after MQTT disconnect.

## Deployment Path

After local validation:

1. Install Docker on Ubuntu cloud server.
2. Copy `tools/remote_mqtt/`.
3. Run `docker compose up -d`.
4. Open inbound ports:
   - `1883` for MQTT.
   - `3000` for the demo web page, or proxy it behind Nginx later.
5. Change ESP32 MQTT URI to `mqtt://<cloud-ip-or-domain>:1883`.
6. Rebuild/flash or use the future configuration page to update the broker address.

Security remains intentionally minimal for this MVP. Before exposing the server broadly, add at least broker username/password, web login, and eventually TLS.

## Acceptance Criteria

- A developer can run the local service from one directory.
- ESP32 publishes status to local MQTT when STA is connected.
- The browser shows online/offline and status fields accurately.
- Browser commands reach ESP32 through MQTT.
- ESP32 publishes ACK for every supported command.
- Pure AP mode does not misleadingly show remote connectivity.
- The same service can be moved to Ubuntu by changing deployment host details, not by redesigning the protocol.
