# Cloud Raw WSS Duplex Design

## Goal

Remove the remaining cloud parameter-oscilloscope request latency by carrying browser-to-device UART frames over the device's existing cloud WebSocket connection. The real-time path becomes:

`browser <-> cloud WebSocket service <-> ESP32 WebSocket client <-> UART`

MQTT remains available for status, commands, discovery, and non-real-time bus traffic, but it is never a fallback for frames received from `/ws/device/{deviceId}`.

## Evidence

The one-way binary-uplink build completed 40 UART requests and 40 UART responses on the ESP32, and queued and sent all 40 responses over WSS with zero queue-full, send-failure, disconnect, or fallback events. Browser observations still ranged from 260.2 ms to 2942.2 ms, with a 645.1 ms median and 2569.4 ms P95. This isolates the remaining delay to the cloud-to-ESP32 MQTT request leg.

## Cloud Service

- Keep one active device WSS connection per device ID.
- Give each active device connection its own send lock so requests from multiple browser threads cannot call `ServerConnection.send()` concurrently.
- Route every non-empty browser binary frame of at most 512 bytes directly to that device connection.
- If no device WSS exists, the frame is oversized, the connection is replaced, or `send()` fails, drop the frame and let the browser's existing timeout stop sampling. Do not call `publish_remote_ws_frame()`.
- Expose sent-frame, sent-byte, dropped-frame, and send-failure counters through `/health`.
- Keep the existing non-blocking device-to-browser waveform fan-out unchanged.

## ESP32 Firmware

- Extend `cloud_ws_uplink_config_t` with an `on_downlink` callback and context.
- Accept binary `WEBSOCKET_EVENT_DATA` messages up to 512 bytes.
- Reassemble both client-buffer chunks and WebSocket continuation frames in a fixed-size buffer. Reject gaps, invalid continuations, and oversized messages, and reset assembly state on every connection lifecycle transition.
- On a complete frame, refresh the existing cloud oscilloscope lease using the same stop/non-stop rules as MQTT, then call the existing UART writer.
- Count completed downlink frames, bytes, and rejected or callback-failed frames. Raise `CLOUD_WS_UPLINK_SCHEMA_VERSION` from 4 to 5 and publish the counters in cloud and local status.
- Do not add capability negotiation, transaction envelopes, retries, tickets, authentication, or MQTT fallback.

## Compatibility

- The browser wire format remains the exact raw UART/Modbus bytes already used by local WebSocket mode.
- The existing device-to-browser binary WSS uplink and bounded queue remain unchanged.
- Local AP WebSocket behavior, parameter-table behavior, display behavior, and ordinary MQTT commands remain unchanged.
- A cloud/backend-first deployment is compatible with the currently flashed firmware: direct frames are sent only when its WSS is connected, but old firmware ignores incoming binary data until the new image is flashed.

## Acceptance

- Executable C tests cover complete, client-chunked, continuation-fragmented, invalid, and oversized downlink messages.
- Executable Python tests prove same-device sends are serialized, replacement/detach races are safe, errors are counted, and no fallback hook exists.
- Contract regressions prove the browser handler uses direct WSS only and the firmware callback refreshes the lease before UART forwarding.
- All existing focused regressions and a full ESP-IDF 6.0 build pass.
- Production cloud deployment rebuilds only `remote_mqtt_python-cloud-1` after a timestamped backup.
- A 40-cycle, 500 ms cloud parameter-read probe receives 40/40 responses, records zero MQTT fallback, and targets P95 below 500 ms.
