# Cloud Oscilloscope Overload Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep cloud waveform rendering current by evicting stale queued samples during WAN overload while preserving MQTT fallback for actual WebSocket failure.

**Architecture:** `cloud_ws_uplink_send` becomes the owner of real-time queue overload handling. It retries insertion after removing the oldest queued waveform frame, records deliberate loss separately, and reports whether the newest frame was accepted. `cloud_mqtt` only invokes immediate fallback when the binary uplink is unavailable, while the sender task retains fallback on disconnect or explicit send failure.

**Tech Stack:** ESP-IDF 6.0, FreeRTOS queues, ESP WebSocket Client, cJSON, Node.js static regressions, Python hardware acceptance.

## Global Constraints

- Do not change local WebSocket behavior.
- Do not apply lossy behavior to commands, parameters, status, or management MQTT traffic.
- Keep binary frame aggregation at 2048 bytes and network timeout at 1000 ms.
- MQTT fallback remains mandatory for WebSocket disconnect and explicit send failure.

---

### Task 1: Specify Queue Overload Behavior

**Files:**
- Modify: `scripts/cloud_osc_transport_regression.mjs`

- [ ] Add assertions for drop-oldest/retry-newest queue handling.
- [ ] Add assertions that connected queue pressure is not immediately duplicated through MQTT.
- [ ] Run the regression and confirm it fails for the missing behavior.

### Task 2: Implement Overload Handling and Telemetry

**Files:**
- Modify: `main/cloud_ws_uplink.c`
- Modify: `main/cloud_ws_uplink.h`
- Modify: `main/cloud_mqtt.c`
- Modify: `main/web_api.c`
- Modify: `scripts/cloud_osc_hardware_acceptance.py`

- [ ] Evict the oldest queued frame when insertion fails while the WebSocket is connected.
- [ ] Retry insertion of the newest frame without blocking the UART task.
- [ ] Count evicted source frames in `overload_dropped_frames`.
- [ ] Expose the counter through local and MQTT status JSON.
- [ ] Keep fallback behavior for unavailable/disconnected uplink and send failures.

### Task 3: Verify Firmware and Hardware

**Files:**
- Test: `scripts/cloud_osc_transport_regression.mjs`
- Test: `scripts/remote_mqtt_python_regression.mjs`
- Test: `scripts/cloud_osc_hardware_acceptance.py`

- [ ] Run all focused regressions and Python syntax checks.
- [ ] Build the ESP-IDF firmware.
- [ ] Flash the firmware.
- [ ] Run cloud pure-binary, cloud fault-injection, and local 12-second acceptance tests.
