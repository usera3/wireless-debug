# Cloud Waveform Ingress And Throughput Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve every UART waveform byte while forwarding it to local and cloud browsers at the existing sample rate, without source throttling or queue-size masking.

**Architecture:** Keep UART ingress as the highest-priority bounded path. Replace the local WebSocket pool's linear PSRAM scan inside a critical section with an O(1) free-slot queue, then make the cloud sender collect a bounded batch for at most 40 ms before one compression and WebSocket send. Move the sender's two 512-byte queue scratch records from its nearly exhausted task stack into PSRAM-backed storage.

**Tech Stack:** ESP-IDF 6.0, FreeRTOS queues/tasks, ESP WebSocket client, miniz, Node/Python/C host regressions, ESP32-S3 hardware acceptance.

## Global Constraints

- Do not lower UART/sample throughput.
- Do not increase the cloud queue depth as the fix.
- Do not connect a diagnostic client to `192.168.4.1/ws`.
- Preserve all unrelated dirty-worktree changes.
- Flash only the app partition at `0x10000`; keep the archived SPIFFS image unchanged.
- Hardware acceptance must use the cloud browser WebSocket and retain the raw capture.

---

### Task 1: Constant-Time Local WebSocket Frame Pool

**Files:**
- Modify: `main/wifi_transport.c`
- Create: `scripts/wifi_transport_pool_regression.mjs`

**Interfaces:**
- Consumes: existing `wifi_transport_send()`, `ws_async_send()`, and the 96-slot `wifi_frame_t` pool.
- Produces: O(1) `frame_acquire()`/`frame_release()` implemented with `s_free_frame_queue`.

- [ ] **Step 1: Write the failing structural regression**

Create a Node regression that requires a free-frame queue, nonblocking `xQueueReceive` acquisition, `xQueueSend` release, and rejects `s_pool_lock`, `portENTER_CRITICAL(&s_pool_lock)`, and a linear `for` scan in `frame_acquire()`.

- [ ] **Step 2: Run the regression and verify RED**

Run: `node scripts/wifi_transport_pool_regression.mjs`

Expected: FAIL because the current implementation scans all 96 PSRAM slots while holding `s_pool_lock`.

- [ ] **Step 3: Implement the minimal pool change**

Add `QueueHandle_t s_free_frame_queue`; enqueue every frame pointer once during initialization; acquire with `xQueueReceive(..., 0)` and release with `xQueueSend(..., 0)`. Remove the `in_use` field and pool critical section. Allocate the free-pointer queue from internal RAM so each hot-path operation copies only one pointer with bounded latency.

- [ ] **Step 4: Verify GREEN**

Run: `node scripts/wifi_transport_pool_regression.mjs`

Expected: PASS.

### Task 2: Deadline-Bounded Cloud Aggregation And Stack Headroom

**Files:**
- Create: `main/cloud_ws_batch_policy.h`
- Create: `main/cloud_ws_batch_policy.c`
- Modify: `main/cloud_ws_uplink.c`
- Modify: `main/CMakeLists.txt`
- Create: `scripts/cloud_ws_batch_policy_regression.c`
- Create: `scripts/cloud_ws_batch_policy_regression.py`
- Modify: `scripts/cloud_osc_transport_regression.mjs`

**Interfaces:**
- Consumes: 512-byte uplink source chunks and `CLOUD_WAVEFORM_MAX_RAW_SIZE`.
- Produces: `cloud_ws_batch_wait_us(size_t raw_len, uint32_t elapsed_us)`, targeting 4096 raw bytes with an absolute 40000 us deadline.

- [ ] **Step 1: Write the failing policy and integration regressions**

The C test must assert 40 ms at batch start, decreasing remaining time, zero wait at the byte target, and zero wait at the deadline. The integration regression must require a timed queue peek based on the policy and PSRAM-backed `s_sender_chunk`/`s_sender_next` pointers instead of two frame records on the sender stack.

- [ ] **Step 2: Run the regressions and verify RED**

Run: `python3 scripts/cloud_ws_batch_policy_regression.py && node scripts/cloud_osc_transport_regression.mjs`

Expected: FAIL because no deadline policy exists, queue peeks are immediate, and both queue records live on the sender stack.

- [ ] **Step 3: Implement the policy and sender changes**

Implement a pure remaining-wait policy with `CLOUD_WS_BATCH_TARGET_BYTES=4096` and `CLOUD_WS_BATCH_MAX_WAIT_US=40000`. Start one deadline when the first source chunk is dequeued, wait only for the remaining deadline, stop once the target is met, and drain immediately when backlog already exists. Allocate the two sender scratch frames in PSRAM before task creation, with internal-RAM fallback and complete failure cleanup.

- [ ] **Step 4: Verify GREEN**

Run both regressions again and require PASS.

### Task 3: Build And Hardware Acceptance

**Files:**
- Update generated build outputs under `build/`.
- Create raw/result captures outside Git or under the existing fixture/archive location.

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: verified app binary and 120-second cloud-stream evidence.

- [ ] **Step 1: Run focused and full regressions**

Run the new tests, existing cloud transport/codec/hardware acceptance regressions, router backpressure regression, and every project regression previously used for schema 7.

- [ ] **Step 2: Build the complete ESP-IDF project**

Run from Windows IDF 6.0: `idf.py build` in `D:\Users\sunqi39\Desktop\.codex-fw-osc-continuity-20260723`.

Expected: `Project build complete.` and a new `build/uart_ble_wifi.bin`.

- [ ] **Step 3: Flash app only**

After download mode is confirmed, write `build/uart_ble_wifi.bin` to `0x10000` on the detected FTDI COM port and require `Hash of data verified.`

- [ ] **Step 4: Run 120-second cloud acceptance**

Capture raw bytes through `/ws/device/wd-ac276eab7c9c`, poll schema-7 counters, and require: UART overflow delta 0, uplink queue-full delta 0, overload-drop delta 0, browser-drop delta 0, sample discontinuity count 0, sender stack minimum free above 512 bytes, and sustained received throughput near the UART source rate.

- [ ] **Step 5: Archive the verified state**

Add the final app binary, pre-flash readback, source diff/bundle, raw acceptance capture, result JSON, and refreshed `SHA256SUMS`; then create the outer archive tar without deleting the existing archive directory.
