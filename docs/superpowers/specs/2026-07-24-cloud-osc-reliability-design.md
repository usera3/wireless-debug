# Cloud Oscilloscope Reliability Design

Date: 2026-07-24
Status: Conversation design approved; pending written review

## Problem Statement

The ESP32-hosted local UI is verified for parameter submission, parameter
oscilloscope sampling, and address oscilloscope sampling. The cloud-hosted UI
has two separate failures:

1. The parameter oscilloscope eventually stops after one missing response and
   displays `modbus timeout`.
2. The address oscilloscope starts but displays no waveform, while the transport
   feels bursty and stalls.

The cloud UI, raw WebSocket relay, and ESP32 app must be fixed together. A
cloud-only change cannot repair the device-side uplink failure and disabled
fallback path.

## Observed Evidence

The following results were reproduced against device `wd-ac276eab7c9c` before
any implementation change:

- Parameter polling at 500 ms completed 39 of 40 requests and timed out once.
- A 12-second address oscilloscope run delivered 29 browser frames and 22,098
  bytes, or 1,842 bytes/s. The expected four-channel rate is about 78 KB/s.
- The same run added 1,011 queued device uplink frames, but only 175 were sent.
- It also added 804 queue-full events, 836 overload-dropped frames, and one
  send failure. The largest browser delivery gap was 2.73 seconds.
- The cloud service recorded the device uplink closing with WebSocket code
  1006 immediately after the device send failure.
- Firmware telemetry accumulated `send_failures`, `queue_full`, and
  `overload_dropped_frames`, while all MQTT fallback counters remained zero.
- The deployed cloud `a.js` is the asset from firmware commit `a9d2523`. It
  predates the CRC-valid header/footer anchored frame recovery and extrema
  ordering fixes in Web commits `5d76341` and `12250ea`.

The ESP32 currently aggregates up to 8,192 bytes into one WebSocket send and
allows only 1,000 ms for the send lock and transport write. A failed transport
write causes `esp_websocket_client` to abort the connection. The current sender
then retains incoming UART frames until its bounded queue overwrites them. The
MQTT fallback required by the original design is not wired into the runtime
configuration and is not called by the sender.

## Goals

- Make the cloud address oscilloscope display the same valid samples as the
  local page.
- Keep the raw binary WebSocket uplink stable at the four-channel 10 kHz rate.
- Preserve data through brief uplink reconnects with the existing MQTT fallback.
- Keep cloud parameter sampling running through isolated WAN response losses.
- Never fabricate a successful parameter sample for a failed cycle.
- Preserve existing local AP behavior and its verified frame parser.
- Keep MQTT for status, discovery, and fallback; keep raw WebSocket for normal
  high-rate waveform transport.
- Provide deterministic counters and repeatable hardware acceptance evidence.

## Non-Goals

- No Nginx, authentication, credential, database, or unrelated cloud UI change.
- No bootloader or partition-table flash.
- No protocol change to the motor controller or local UART framing.
- No attempt to carry sustained 78 KB/s waveform traffic through MQTT as the
  normal path.
- No unrelated frontend refactor.

## Proposed Architecture

### 1. Cloud Web Assets

Build the Web branch that already contains the verified dual-anchor frame
parser and time-ordered extrema rendering. Deploy its `dist/orig/` assets to
the cloud static directory after backing up the deployed directory.

The parser contract remains:

- CRC must be valid.
- Header magic or footer magic must be present.
- A block with neither anchor is rejected.
- Min/max display points retain sample positions and are emitted in time order.

No cloud backend or Nginx restart is needed for a static-only asset update.
Asset hashes must be compared after deployment.

### 2. ESP32 Raw Uplink

Keep the raw uplink connected whenever STA is ready, and gate only UART data
forwarding with the existing real-time lease.

Change the sender behavior as follows:

- Limit each normal raw WebSocket message to 2,048 bytes. This matches the
  current cloud browser fan-out chunk and removes 8 KB WAN write bursts.
- Increase the network/write timeout from 1,000 ms to 5,000 ms. A normal 2 KB
  message must not abort the connection because of a short WAN stall.
- Preserve the bounded PSRAM source-frame queue and existing lease generation
  ordering.
- If the uplink is disconnected or a raw send fails, forward the affected bytes
  through `cloud_mqtt_publish_ws_fallback` in bounded chunks.
- Wire the fallback callback in `main.c`; it must not remain `NULL`.
- Count each source frame in exactly one terminal or current state: raw sent,
  queued fallback sent, overload dropped, explicit-stop dropped, or pending.
- Do not send both raw and fallback copies of the same bytes.
- Keep automatic raw WebSocket reconnect enabled. Successful reconnect resumes
  raw sends without requiring a browser restart.

MQTT fallback is continuity protection for short outages. If MQTT enqueue also
fails, record the failure and drop the affected data rather than blocking the
UART path indefinitely.

### 3. Cloud Parameter Oscilloscope

Keep one request in flight at a time and match responses by expected register
count. Local behavior remains unchanged.

For a cloud target:

- A failed cycle appends no sample and increments the I/O error count.
- One or two consecutive failed cycles are treated as transient. Sampling stays
  running and the next interval retries normally.
- A successful cycle resets the consecutive-failure count.
- Three consecutive failed cycles stop sampling and retain the final error.
- Add an explicit connection-state cleanup path: when the shared connection
  store changes to disconnected, an active parameter oscilloscope stops,
  releases its frame waiter, and clears its polling timer immediately.

This policy removes the current single-loss terminal stop without hiding a
sustained outage or inserting zero-valued fake samples.

### 4. Cloud Relay

Keep the current direct binary relay and bounded per-browser send pump. The
controlled run did not increase browser-pump drop counters; loss occurred at
the device uplink before relay delivery.

The service health counters remain the operational evidence surface. Backend
code is changed only if a failing regression demonstrates a relay accounting
defect. Nginx remains untouched.

## Data Flow

Normal address oscilloscope flow:

```text
Browser control -> cloud /ws/device -> device /ws/uplink -> UART motor
UART waveform -> ESP32 2 KB raw WSS messages -> cloud fan-out -> browser parser
```

Transient raw-uplink failure:

```text
UART waveform -> bounded ESP32 queue -> MQTT fallback -> cloud fan-out
                raw WSS reconnects -> subsequent bytes resume on raw WSS
```

Parameter sampling:

```text
Browser FC03 -> raw downlink -> UART -> raw uplink response -> matching waiter
missing response -> failed cycle, no sample -> retry on next interval
three consecutive failures -> stop and show terminal error
```

## Error Handling and Observability

- Device telemetry continues to expose raw sends, bytes, queue depth, queue
  full, overload drops, send failures, fallback frames, fallback failures,
  reconnect events, and downlink failures.
- The parameter UI distinguishes transient failed cycles from terminal stop by
  keeping `running` true until the consecutive-failure budget is exhausted.
- A failed cycle does not advance sample history.
- Cloud logs retain device/browser connect and close events without credentials
  or payload contents.
- No secret value is written to tests, logs, commits, or documentation.

## Test Strategy

Implementation follows red-green TDD.

### Web Tests

- Add a failing transport-policy regression proving that cloud failures one and
  two continue, failure three stops, and success resets the count.
- Prove failed cycles append no samples.
- Prove a connection-state transition to disconnected stops polling and releases
  the active response waiter.
- Keep local timeout behavior unchanged.
- Run the frame router, extrema order, pipeline replay, cloud transport, unified
  smoke, production build, and lint checks.

### Firmware and Service Tests

- Add failing contract tests for 2,048-byte aggregation, 5,000 ms timeout,
  runtime fallback wiring, and no disabled fallback callback.
- Add behavior coverage for disconnected and send-failure fallback accounting.
- Keep lease ordering, downlink reassembly, backend relay, and server fan-out
  regressions passing.
- Build the ESP-IDF app from a clean verified state.

### Hardware Acceptance

After cloud asset deployment and app flashing:

1. Run cloud parameter sampling at 500 ms for at least five minutes. It must not
   terminate on an isolated miss, must not create fake samples, and must stop
   only after three consecutive failures.
2. Run the four-channel cloud address oscilloscope for at least 60 seconds.
   Require at least 60 KB/s, P95 frame interval at most 100 ms, maximum gap at
   most 750 ms, and no new uplink send failure, queue-full, or overload-drop
   event in the stable path.
3. Force one duplicate-uplink replacement. Require MQTT fallback evidence,
   browser delivery during the outage, no fallback failure, and raw reconnect.
4. Re-run the local C52C continuity check to prove local frame/sample identity
   and rendering remain unchanged.
5. Verify the deployed cloud `a.js` hash matches the tested build.

Playwright records the cloud parameter and address UI states after protocol-level
acceptance passes.

## Deployment and Rollback

Deployment order:

1. Back up the current cloud `dist/orig/` directory.
2. Deploy and hash-check the tested cloud Web assets.
3. Build and archive the new app image and its flash arguments.
4. Flash only the app image at `0x10000` after the device enters download mode.
5. Reset normally and run the hardware acceptance suite.

Do not flash bootloader, partition table, or storage for this phase. The local
SPIFFS page already contains the verified address-parser fix.

Rollback uses the archive created before this work:

`D:\Users\sunqi39\Desktop\archives\osc-continuity-20260724-153621`

- Restore cloud assets from the archive or the pre-deployment server backup.
- Restore app image `flash-artifacts/uart_ble_wifi.bin` at `0x10000`.
- The archived `storage.bin` remains available at `0x290000` but is not part of
  the normal rollback for this app-only change.

## Repository Boundaries

- Web implementation branch: `fix/cloud-osc-reliability-web-20260724`
- Firmware/cloud branch: `fix/cloud-osc-reliability-fw-20260724`
- The previously archived branches remain unchanged and recoverable from their
  Git bundles.
