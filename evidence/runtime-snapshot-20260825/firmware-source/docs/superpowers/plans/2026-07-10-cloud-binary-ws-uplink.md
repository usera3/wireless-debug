# Cloud Binary WebSocket Uplink Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry cloud address-oscilloscope return data over a direct binary WebSocket uplink while retaining MQTT for control, status, device discovery, and automatic fallback.

**Architecture:** The browser remains connected to `/ws/device/{deviceId}` and sends control frames through the existing MQTT bridge. ESP32 maintains a separate `/ws/uplink/{deviceId}` connection while STA networking is available; during an active cloud oscilloscope window it sends raw UART bytes as binary frames. The Python service binds one device uplink per device ID and forwards those binary frames directly to matching browser connections without JSON, hex encoding, MQTT, or database writes.

**Tech Stack:** ESP-IDF 6.0, `espressif/esp_websocket_client` 1.7.x, C, Python `websockets`, MQTT, Node regression scripts.

## Global Constraints

- MQTT remains the control/status/device-management transport.
- Existing local `ws://192.168.4.1/ws` behavior must not change.
- Binary uplink failure must automatically fall back to the existing QoS 0 MQTT waveform path.
- Browser and device WebSocket roles must use distinct paths and server-side registries.
- High-rate binary waveform frames must never touch PostgreSQL.
- No new security mechanism is required for this prototype.

---

### Task 1: Cloud Role Separation and Binary Relay

**Files:**
- Modify: `tools/remote_mqtt_python/app.py`
- Modify: `scripts/remote_mqtt_python_regression.mjs`

- [x] Add failing contract assertions for `/ws/uplink/`, separate uplink registry, and direct binary broadcast.
- [x] Implement path parsing and separate browser/device handlers.
- [x] Replace an older uplink connection atomically when the same device reconnects.
- [x] Preserve browser-to-device control through `publish_remote_ws_frame()` and MQTT.
- [x] Run backend regressions.

### Task 2: ESP32 Binary Uplink Module

**Files:**
- Create: `main/cloud_ws_uplink.c`
- Create: `main/cloud_ws_uplink.h`
- Modify: `main/idf_component.yml`
- Modify: `main/CMakeLists.txt`
- Modify: `main/Kconfig.projbuild`
- Modify: `main/main.c`
- Modify: `main/cloud_mqtt.c`
- Modify: `main/cloud_mqtt.h`
- Modify: `scripts/cloud_osc_transport_regression.mjs`

- [x] Add failing firmware contract assertions for the managed component, uplink URI, lifecycle, binary send, and MQTT fallback.
- [x] Add `espressif/esp_websocket_client ^1.7.0`.
- [x] Initialize and maintain the uplink according to STA connectivity.
- [x] Send raw UART chunks only during the existing cloud oscilloscope active window.
- [x] Fall back to MQTT whenever the uplink is unavailable or binary send fails.
- [x] Move the 8 x 512-byte waveform queue to PSRAM with internal-RAM fallback and serialize start/stop transitions.
- [x] Keep lifecycle start/stop and queue draining in one notification-driven 4096-byte worker task so timer callbacks never block and no second internal-RAM task stack is required.
- [x] Preserve queued frames across a transient STA outage so they drain through MQTT fallback; only an explicit oscilloscope stop discards stale queued frames.
- [x] Use a short static critical section for desired-state updates so timer callbacks never wait on a FreeRTOS mutex.
- [x] Track successful queued fallback, failed MQTT fallback, and explicit-stop queue drops separately for exact frame accounting.
- [x] Report queue placement and sender task stack high-water mark in device status telemetry.
- [x] Expose the same `cloud_ws_uplink` schema version 2 object through both cloud MQTT status and local `/api/device/status`, including response-truncation protection on the local API.
- [x] Protect the cloud oscilloscope streaming flag and 64-bit heartbeat deadline with a dedicated critical section across MQTT, timer, and UART tasks.
- [x] Count explicit-stop queue drops by draining frames individually instead of resetting after a non-atomic queue-length snapshot.
- [x] Move the local WebSocket burst pool and pointer queue to PSRAM, expand the bounded pool from 32 to 96 frames, and replace the UART-path mutex wait with a short critical section.
- [x] Run firmware regressions and `idf.py build`.

### Task 3: Cloud Deployment and Measured Verification

**Files:**
- Deploy backend `app.py` and rebuild only the `cloud` service.
- Flash firmware after build verification.

- [x] Verify existing browser WS and MQTT control behavior before flashing.
- [x] Deploy the cloud backend and verify health plus both WS paths.
- [ ] Flash firmware and confirm uplink connection in cloud logs.
- [ ] Run the cloud address oscilloscope for at least 12 seconds.
- [ ] Compare frame interval median, P95, maximum gap, frame count, and bytes/sec against the MQTT baseline.
- [ ] Force/disconnect the uplink and verify MQTT waveform fallback still works.

Current unattended verification (2026-07-10): cloud health is OK, binary relay is byte-exact,
browser control still reaches MQTT, duplicate MQTT waveform frames are suppressed while an
uplink is active, and MQTT relay resumes after uplink disconnect. The final four checks require
the latest `build/uart_ble_wifi.bin` to be flashed and the ESP32 STA interface to have internet.
Hardware currently runs an older image without the `cloud_ws_uplink` status object, so no
real-device result may be attributed to the artifact recorded below until it is flashed.

Latest build also changes local transport scheduling: HTTPD priority 9, UART reader priority 8,
and WiFi staging priority 7. The previously flashed firmware produced 892 osc frames in a 7-second
10 kHz local run, while `wifi.pool_exhausted` increased by 295 and UART overflow reached 39. After
flashing the latest build, repeat the same run and require both counter deltas to be zero or clearly
lower; keep communication mode restored to AUTO after the test.

Latest artifact fingerprints:

- `build/uart_ble_wifi.bin`: size `0x1951e0`, SHA-256 `51505398a267bfe01f4f478ffbb33ac33b6171e09b4741f8686d67bb53c66506`
- `build/storage.bin`: `b66160764126007baf4834d5a7f531544e9179c5fc10f501291f0611e29a1b1f`
- `build/bootloader/bootloader.bin`: `6b13c9cc54c28cfbc67583e0f229934bd707e0e857c1fd63fa40195c59584f86`
- `build/partition_table/partition-table.bin`: `b97d38a2ea6ab2a2d4763e8ece2a01f267e935ac67a4a8dbf67bf3728b78f61d`

## Repeatable Hardware Acceptance

The wrapper installs the test-only WebSocket dependency into a temporary virtual environment:

```bash
scripts/run_cloud_osc_hardware_acceptance.sh --help
```

Local AP test (restores communication mode to AUTO in the cleanup path):

```bash
scripts/run_cloud_osc_hardware_acceptance.sh \
  --mode local --duration 12 \
  --output /tmp/wireless-debug-local-acceptance.json
```

Cloud binary-uplink and real MQTT-fallback test:

```bash
CLOUD_HTTP_USER='<user>' CLOUD_HTTP_PASSWORD='<password>' \
scripts/run_cloud_osc_hardware_acceptance.sh \
  --mode cloud --device-id wd-ac276eab7c9c --duration 12 \
  --output /tmp/wireless-debug-cloud-acceptance.json
```

The cloud test temporarily connects a replacement `/ws/uplink/{deviceId}` client. The server
closes the ESP32 uplink by its normal duplicate-uplink rule, the replacement immediately exits,
and the still-running browser stream must receive data through the firmware MQTT fallback until
the ESP32 reconnects. No broker or cloud service restart is required.

Default acceptance gates:

- at least 15 KB/s received waveform traffic;
- local P95 frame interval at most 50 ms, cloud P95 at most 100 ms;
- maximum frame gap at most 750 ms;
- no UART overflow during either test;
- local: no WiFi frame-pool exhaustion, send-queue full, or route partial drop;
- cloud: PSRAM queue active, binary frames and bytes sent, no uplink queue full;
- cloud: every newly queued uplink frame is accounted for exactly by binary send, successful queued MQTT fallback, or explicit-stop discard, with zero MQTT fallback failures;
- cloud fault injection: `fallback_frames` increases, the browser receives waveform-sized frames
  during the binary-uplink outage, and `/remote/{deviceId}/ws/poll` records new waveform frames
  after the exact fault-window baseline. Together these prove firmware fallback, cloud MQTT relay,
  and browser delivery rather than only an attempted fallback.

Old flashed firmware baseline from the acceptance tool (3 seconds): 813 frames, 69,541 B/s,
P95 18.69 ms, but UART overflow +22, WiFi pool exhaustion +241, and route partial drop +241.
This is an expected failure and is the comparison point for the final scheduling build.
The full baseline report is `/tmp/wireless-debug-local-acceptance-old-firmware.json`.
