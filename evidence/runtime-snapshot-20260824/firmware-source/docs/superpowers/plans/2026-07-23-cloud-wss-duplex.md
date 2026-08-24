# Cloud Raw WSS Duplex Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cloud parameter oscilloscope's MQTT request leg with raw, full-duplex WSS while preserving the Wednesday firmware/web behavior everywhere else.

**Architecture:** The Python bridge owns one serialized downlink sender per connected device and sends browser binary messages directly through that device's `/ws/uplink/{deviceId}` connection. ESP32 reassembles bounded binary messages, refreshes its existing response lease, and forwards the exact bytes to UART; UART responses continue through the already implemented binary uplink and browser send pumps.

**Tech Stack:** Python 3.12, `websockets` sync server, ESP-IDF 6.0, `esp_websocket_client` 1.7.x, C, Node/Python/C regression scripts.

## Global Constraints

- No browser-to-device MQTT fallback is allowed.
- No ticket, authentication, capability-negotiation, or transaction-envelope protocol is allowed.
- Raw browser UART frames are limited to 512 bytes.
- Local AP WebSocket, parameter table, display, and ordinary MQTT behavior must remain unchanged.
- Deploy only Wireless Debug backend files and rebuild only its `cloud` container.
- Do not probe `192.168.4.1` from the shell.

---

### Task 1: Executable Downlink Contracts

**Files:**
- Create: `scripts/cloud_ws_downlink_regression.py`
- Create: `scripts/cloud_ws_downlink_reassembly_regression.c`
- Modify: `scripts/remote_mqtt_python_regression.mjs`
- Modify: `scripts/cloud_osc_transport_regression.mjs`
- Modify: `scripts/cloud_mqtt_contract_regression.mjs`

**Interfaces:**
- Consumes: Current `BrowserSendPump`, cloud WSS handlers, and `cloud_ws_uplink` event API.
- Produces: Expected APIs `DeviceDownlinkRouter`, `cloud_ws_downlink_reassembly_push()`, `cloud_mqtt_note_realtime_control()`, and `cloud_ws_uplink_config_t.on_downlink`.

- [ ] **Step 1: Add the Python router regression**

Cover two concurrent sends to one fake connection, independent sends to different devices, stale detach after replacement, no-uplink/oversize/send-error results, and exact metric values.

- [ ] **Step 2: Run the Python regression and verify RED**

Run: `python3 scripts/cloud_ws_downlink_regression.py`

Expected: import failure because `DeviceDownlinkRouter` does not exist.

- [ ] **Step 3: Add the C reassembly regression**

Compile a host executable that pushes complete messages, multiple client-buffer chunks, true WebSocket continuation frames, out-of-order chunks, and a message exceeding 512 bytes.

- [ ] **Step 4: Run the C regression and verify RED**

Run: `cc -std=c11 -Wall -Wextra -Werror scripts/cloud_ws_downlink_reassembly_regression.c -o /tmp/cloud_ws_downlink_reassembly_regression`

Expected: compile failure because `main/cloud_ws_downlink_reassembly.h` does not exist.

- [ ] **Step 5: Add static direct-route and firmware-wiring assertions**

Require the browser handler to call only `send_cloud_ws_downlink()`, require schema 5 and downlink telemetry, and require lease refresh before the UART callback.

- [ ] **Step 6: Run the contract regressions and verify RED**

Run: `node scripts/remote_mqtt_python_regression.mjs && node scripts/cloud_osc_transport_regression.mjs && node scripts/cloud_mqtt_contract_regression.mjs`

Expected: failure on the first missing direct-downlink contract.

### Task 2: Serialized Cloud WSS Downlink

**Files:**
- Modify: `tools/remote_mqtt_python/ws_fanout.py`
- Modify: `tools/remote_mqtt_python/app.py`

**Interfaces:**
- Produces: `DeviceDownlinkRouter(max_frame_bytes)`, with `attach()`, `detach()`, `connected()`, `send()`, `device_count()`, and `snapshot()`.
- Produces: `send_cloud_ws_downlink(device_id, data)` returning `(ok, reason)`.

- [ ] **Step 1: Implement the minimum router**

Use a registry lock for connection replacement and one lock per active connection for `send()`. Recheck that the entry is still current after acquiring its send lock.

- [ ] **Step 2: Wire browser and uplink handlers**

Replace `publish_remote_ws_frame()` in `cloud_ws_browser_handler()` with `send_cloud_ws_downlink()`. Attach/detach device connections in `cloud_ws_uplink_handler()` and close the replaced connection after attaching the new one.

- [ ] **Step 3: Export health metrics**

Add `ws_downlink_sent_frames`, `ws_downlink_sent_bytes`, `ws_downlink_dropped_frames`, and `ws_downlink_send_failures` to `/health`.

- [ ] **Step 4: Run Python and backend contract tests and verify GREEN**

Run: `python3 scripts/cloud_ws_downlink_regression.py && node scripts/remote_mqtt_python_regression.mjs`

Expected: both pass with no fallback call in the browser handler.

### Task 3: Bounded ESP32 Downlink and UART Wiring

**Files:**
- Create: `main/cloud_ws_downlink_reassembly.h`
- Modify: `main/cloud_ws_uplink.h`
- Modify: `main/cloud_ws_uplink.c`
- Modify: `main/cloud_mqtt.h`
- Modify: `main/cloud_mqtt.c`
- Modify: `main/main.c`
- Modify: `main/web_api.c`

**Interfaces:**
- Produces: `cloud_ws_downlink_reassembly_push(state, opcode, fin, payload_len, payload_offset, data, data_len, out_data, out_len)`.
- Produces: `cloud_mqtt_note_realtime_control(data, len)`.
- Consumes: Existing `cloud_send_ws_frame(data, len, ctx)` UART callback.

- [ ] **Step 1: Implement fixed-buffer reassembly**

Track total message bytes plus current WebSocket-frame offset. Accept opcode `0x2` only as a new message and opcode `0x0` only while awaiting continuation; return complete only when the final frame and all of its client-buffer chunks are present.

- [ ] **Step 2: Verify the C regression GREEN**

Run: `cc -std=c11 -Wall -Wextra -Werror scripts/cloud_ws_downlink_reassembly_regression.c -o /tmp/cloud_ws_downlink_reassembly_regression && /tmp/cloud_ws_downlink_reassembly_regression`

Expected: `cloud websocket downlink reassembly regression passed`.

- [ ] **Step 3: Handle WSS binary data**

Reset reassembly on connect/disconnect/close/error. On a completed message, call `on_downlink`; count complete frames/bytes on success and failures on rejection or callback error.

- [ ] **Step 4: Refresh the existing lease before UART output**

`cloud_mqtt_note_realtime_control()` applies the same stop/non-stop generation update used by `handle_bus_ws_frame()`. A new `cloud_handle_ws_downlink()` wrapper calls it before `cloud_send_ws_frame()` and is registered in `cloud_ws_uplink_config_t`.

- [ ] **Step 5: Publish schema 5 telemetry**

Add downlink frame, byte, and failure fields to cloud MQTT status and local `/api/device/status`.

- [ ] **Step 6: Run firmware contracts and verify GREEN**

Run: `node scripts/cloud_osc_transport_regression.mjs && node scripts/cloud_mqtt_contract_regression.mjs`

Expected: both pass.

### Task 4: Build, Deploy, Flash, and Measure

**Files:**
- Build firmware and existing web static assets already present in `dist/orig`.
- Deploy: `tools/remote_mqtt_python/app.py`, `tools/remote_mqtt_python/ws_fanout.py`.

- [ ] **Step 1: Run all focused regressions and the web build**

Run the existing cloud transport, MQTT contract, backend, lease, Web Modbus/frame-router/connection/oscilloscope regressions and `npm run build` in the web worktree.

- [ ] **Step 2: Run a clean ESP-IDF build**

Run: `cmd.exe /C "cd /D D:\\Users\\sunqi39\\Desktop\\.codex-restore-check-fw-e7ccb99 && C:\\esp\\v6.0\\esp-idf\\export.bat >nul 2>nul && idf.py build"`

Expected: `Project build complete.`

- [ ] **Step 3: Back up and deploy cloud files**

Create a timestamped backup under `/home/ubuntu/wireless-debug-cloud/tools/remote_mqtt_python`, upload only the two backend files, and run `sudo docker compose up -d --build cloud` from that directory.

- [ ] **Step 4: Verify production health and direct-route counters**

Confirm the Wireless Debug containers remain healthy, the device uplink reconnects, and `/health` exposes all four downlink counters.

- [ ] **Step 5: Flash all firmware partitions**

After the user enters download mode, flash bootloader, partition table, application, and SPIFFS through COM4 and verify every written partition hash.

- [ ] **Step 6: Run the production continuity probe**

After reset, run 40 parameter-read cycles at 500 ms through the cloud container. Require 40 requests, 40 responses, zero MQTT fallback, and inspect median/P95/max latency plus ESP32 downlink/uplink counters.
