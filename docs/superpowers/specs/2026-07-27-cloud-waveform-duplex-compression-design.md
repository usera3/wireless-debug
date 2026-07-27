# Cloud Waveform Duplex Compression Design

Date: 2026-07-27
Status: Conversation design approved; pending written review

## Problem Statement

The cloud address oscilloscope uses one full-duplex WebSocket connection for
both high-rate device-to-cloud waveform data and low-rate cloud-to-device UART
control. The ESP32 sends waveform data through synchronous
`esp_websocket_client_send_bin()` calls. On the current mobile uplink, those
calls delay inbound heartbeat processing long enough for the motor
oscilloscope's three-second watchdog to expire.

The deployed Web reconnect policy now keeps the UI in the running state across
brief browser reconnects, but it cannot restore samples after the motor exits
oscilloscope mode. Increasing queue depth or changing browser fan-out pacing
does not remove the full-duplex head-of-line blocking.

## Reproduced Evidence

The diagnosis was reproduced against device `wd-ac276eab7c9c` after a clean
reboot:

- A 60-second raw cloud run delivered 186,442 browser bytes, or 3,107 bytes/s.
  P95 message interval was 1,496.98 ms and the largest gap was 6,062.47 ms.
- The same run queued 653 firmware source chunks, sent 516, and evicted 137
  after queue-full events. Firmware reported no UART overflow or raw send
  failure.
- A 20-second no-fault-injection run received 249,944 UART bytes, sent 206,777
  raw bytes, and evicted 102 source chunks. Browser fan-out drop counters did
  not increase.
- The deployed page stayed connected and reported `running` for 20 seconds,
  but cache stopped at about 1.0 second after the browser received an initial
  178,620-byte burst.
- Browser control tracing proved that no unexpected stop was sent. Heartbeats
  were emitted every second.
- Heartbeat ACK tracing showed heartbeats sent at approximately 8.81, 9.81,
  10.81, 11.81, and 12.81 seconds arriving together at approximately 13.43
  seconds. The first ACK was delayed about 4.6 seconds, beyond the protocol's
  three-second watchdog.
- The cloud uplink handler performs only receive, bounded enqueue, and fan-out;
  it does not access PostgreSQL or synchronously send to browser sockets.

This isolates the primary failure to full-duplex contention on the ESP32 cloud
WebSocket connection. Raw bandwidth pressure is also independently confirmed
by firmware queue evictions.

## Goals

- Prevent waveform uploads from delaying heartbeat and control downlink beyond
  the motor watchdog window.
- Preserve the exact UART byte stream observed by the browser after cloud
  decoding.
- Sustain the four-channel cloud waveform without firmware queue eviction,
  browser fan-out loss, or parser discontinuity.
- Keep the current raw full-duplex downlink for parameter requests, channel
  configuration, start, stop, and heartbeat frames.
- Preserve local AP behavior and local WebSocket bytes unchanged.
- Preserve backward compatibility during independent server and firmware
  rollout or rollback.
- Retain current MQTT status, discovery, and bounded failure fallback roles.

## Non-Goals

- No lossy decimation or permanent `0x73` rate limit.
- No second TLS/WebSocket connection for control traffic.
- No browser waveform wire-format change.
- No motor-controller protocol or UART framing change.
- No Nginx, authentication, PostgreSQL, Mosquitto, or unrelated-service change.
- No bootloader, partition-table, or SPIFFS flash.
- No unrelated frontend refactor.

## Selected Architecture

Add negotiated lossless compression only to the device-to-cloud waveform
direction of the existing duplex WebSocket. The cloud decodes each negotiated
envelope before invoking the existing browser fan-out, so browsers continue to
receive the original raw UART bytes.

The control direction remains unchanged:

```text
Browser raw UART frame
  -> cloud /ws/device/{id}
  -> existing device /ws/uplink/{id} connection
  -> ESP32 downlink reassembly
  -> UART
```

The waveform direction becomes:

```text
UART raw bytes
  -> bounded ESP32 queue
  -> non-blocking raw aggregation
  -> negotiated lossless envelope
  -> cloud validation/decompression
  -> existing bounded browser fan-out
  -> original raw bytes
```

Compression reduces the duration for which synchronous uplink sends occupy the
WebSocket/network path. The measured reference waveform was approximately 96%
zero bytes and previously compressed to about 0.88% of its raw size, which is
well below the currently measured raw uplink capacity.

## Capability Negotiation

Negotiation is per device WebSocket connection and is initiated by new
firmware. This direction is required because the currently deployed raw-duplex
firmware forwards unsolicited server binary messages to UART.

1. After connecting, new firmware sends one binary capability offer `WDC1`
   from its sender task. It does not wait or block raw fallback traffic.
2. A compression-capable cloud server consumes the exact four-byte offer and
   replies with binary marker `WDC1` on that device connection.
3. Firmware recognizes only a complete binary `WDC1` reply as transport
   control. It consumes the marker and never forwards it to UART.
4. Firmware enables envelopes only after receiving that reply. The cloud
   enables envelope decoding immediately after replying to the recognized
   offer.

Connection loss clears capability and activation state. The WebSocket event
callback may update state and wake the sender task, but it must not compress or
send waveform data itself.

Compatibility rules:

- New server plus old firmware: old firmware sends no offer, so the server sends
  no marker and continues forwarding legacy raw messages.
- New firmware plus old server: the old server forwards the one four-byte offer
  to browser clients as legacy raw data. Browser framing rejects that harmless
  fragment, no reply arrives, and firmware continues the current raw uplink
  behavior.
- New server plus new firmware: activation switches only the uplink waveform
  direction to envelopes. Browser-to-device raw control is unchanged.

## Envelope Format

After activation, every waveform message uses a 16-byte network-byte-order
header followed by encoded payload:

| Offset | Size | Field |
| --- | ---: | --- |
| 0 | 4 | Magic/version `WDZ1` |
| 4 | 1 | Codec: `0` raw, `1` zlib deflate |
| 5 | 3 | Reserved, all zero |
| 8 | 4 | Uncompressed byte length |
| 12 | 4 | CRC32 of uncompressed bytes |
| 16 | N | Raw or compressed payload |

The maximum uncompressed aggregate is 32,768 bytes. Firmware uses ESP-IDF's
Miniz-compatible level-1 deflate. It sends codec `0` when compression fails or
does not reduce total message size. This keeps the negotiated stream
unambiguous and byte-preserving.

The current 128-frame PSRAM source queue remains bounded. Aggregation drains
only currently queued chunks and does not add a coalescing delay. Aggregate and
wire buffers prefer PSRAM. The server WebSocket message limit is raised to a
value that safely accepts the maximum raw envelope and compression bound.

## Failure Handling

- Invalid envelopes are never forwarded to browsers. The server records a
  reasoned decode failure and keeps the connection alive for isolated errors.
- Server validation rejects bad magic, non-zero reserved bytes, unsupported
  codec, invalid length, decompression beyond the declared limit, trailing
  compressed data, length mismatch, and CRC mismatch.
- Compression failure produces a raw envelope and increments firmware
  compression-failure telemetry; it does not fabricate or alter samples.
- A capability-offer or reply failure leaves compression inactive without
  blocking legacy raw waveform forwarding.
- A raw WebSocket disconnect or send failure retains the existing bounded MQTT
  fallback behavior for affected raw bytes. It must not send both raw and
  fallback copies of the same source chunk.
- Queue overload continues to evict oldest source chunks rather than block the
  UART task, but stable-path acceptance requires zero overload evictions.
- Automatic raw WebSocket reconnect remains enabled. Negotiation restarts on
  every new connection.

## Observability

Firmware telemetry advances to schema version 6 and adds:

- `compression_capable` and `compression_active`;
- compression calls, compressed frames, and raw-envelope frames;
- compression failures;
- raw bytes and physical wire bytes;
- total and maximum compression microseconds;
- existing queue, fallback, send, reconnect, and downlink counters.

Cloud `/health` adds lock-protected waveform codec metrics:

- wire bytes and decoded raw bytes;
- activation, compressed, raw-envelope, and legacy-raw message counts;
- decode failures grouped by reason;
- total and maximum decode microseconds.

No credential or payload contents are logged.

## Resource And Timing Budgets

- Firmware average compression time: at most 5 ms per aggregate.
- Firmware maximum compression time: at most 10 ms.
- Cloud average decode time: at most 1 ms per message.
- Internal ESP32 minimum free heap: at least 8 KB during sustained sampling.
- Heartbeat ACK P95: at most 500 ms.
- Heartbeat ACK maximum: below 2,000 ms, leaving margin under the three-second
  motor watchdog.
- Decoded browser bytes must be exactly equal to the original raw bytes in
  deterministic cross-language fixtures.

## Test Strategy

Implementation follows red-green TDD.

### Codec And Contract Tests

- Python table-driven tests cover negotiation, raw legacy pass-through, codec 0,
  codec 1, exact restoration, every bounded decode rejection, and telemetry.
- C/static firmware tests cover Miniz level 1, network byte order, CRC32,
  PSRAM-first buffers, capability state transitions, activation only after a
  complete server reply, reconnect reset, and raw behavior without capability.
- Cross-language fixtures compare uncompressed length and SHA-256 before and
  after cloud decoding for zero-heavy, mixed, and incompressible payloads.
- Existing duplex downlink reassembly, lease ordering, MQTT fallback, browser
  fan-out, cloud backend, Web parser, reconnect, and local replay regressions
  remain green.

### Hardware Acceptance

After server-first deployment and app-only flash:

1. Confirm schema 6, compression negotiated, raw uplink connected, and queue in
   PSRAM.
2. Run the cloud address oscilloscope for at least 60 seconds with CH1=`c52c`
   and four int16 channels.
3. Require decoded browser throughput of at least 60 KB/s, P95 delivery gap at
   most 100 ms, maximum gap at most 750 ms, and address cache growth of at least
   30 seconds.
4. Require zero UART overflow, queue-full event, overload eviction, raw send
   failure, browser-pump drop, decode failure, and unaccounted source chunk in
   the stable path.
5. Require compressed wire bytes below 20% of raw bytes for the measured
   zero-heavy stream and all compression/decode timing budgets to pass.
6. Trace heartbeat sends and ACKs during the high-rate run and enforce the ACK
   latency budgets above.
7. Force one duplicate-uplink replacement and require bounded fallback evidence,
   no fallback failure, and successful renegotiation after raw reconnect.
8. Run five minutes of cloud parameter sampling. Isolated misses may not stop
   the page or fabricate samples; three consecutive failures remain terminal.
9. Re-run local AP address and parameter regression to prove no local behavior
   or byte-stream change.

## Deployment And Rollback

Deployment is server first:

1. Back up every Wireless Debug cloud file being replaced.
2. Deploy codec-aware cloud files and rebuild only the `cloud` service.
3. Verify current raw firmware receives no capability marker, still works, and
   is reported as legacy raw.
4. Build the ESP-IDF app, archive the app binary and metadata with SHA-256, and
   confirm it fits the app partition.
5. After explicit download-mode confirmation, flash only
   `build/uart_ble_wifi.bin` at `0x10000`.
6. Reset normally and run the full acceptance suite before declaring success.

Rollback remains independent:

- Rolling firmware back leaves the new server accepting legacy raw messages.
- Rolling the server back causes new firmware to receive no capability marker
  and use legacy raw messages.
- Existing archived app and cloud backups remain the recovery source.

Nginx, Mosquitto, PostgreSQL, bootloader, partition table, and SPIFFS are not
modified or restarted by this work.

## Repository Boundaries

- Firmware/cloud repository:
  `/mnt/d/Users/sunqi39/Desktop/.codex-fw-osc-continuity-20260723`
- Web repository:
  `/mnt/d/Users/sunqi39/Desktop/.codex-osc-continuity-20260723`
- Firmware/cloud branch: `fix/cloud-osc-reliability-fw-20260724`
- Web branch: `fix/cloud-osc-reliability-web-20260724`

The implementation stays on these archived working branches. No push, merge,
branch deletion, or worktree cleanup is part of this design.
