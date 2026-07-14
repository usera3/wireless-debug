# Cloud Oscilloscope Overload Policy

## Goal

Keep the cloud oscilloscope close to real time when the device produces waveform data faster than the WAN can carry it, without weakening reliable control traffic or WebSocket failure fallback.

## Behavior

- The policy applies only to live waveform frames queued by `cloud_ws_uplink`.
- While the binary WebSocket is connected, a full queue evicts the oldest queued waveform frame and inserts the newest frame.
- Queue pressure while connected does not publish the rejected or evicted waveform through MQTT.
- When the WebSocket is disconnected, or a binary send explicitly fails, frames continue to use the existing MQTT fallback path.
- Local WebSocket transport, commands, parameter operations, status, and other MQTT management traffic are unchanged.

## Telemetry

Add `overload_dropped_frames` to the uplink status. It counts source waveform frames deliberately evicted to keep latency bounded. It is separate from `queue_full`, transport failures, and MQTT fallback failures.

## Acceptance

- Static regression proves queue-full handling evicts one old frame and retries the newest frame.
- Static regression proves connected queue pressure no longer invokes immediate MQTT fallback in `cloud_mqtt.c`.
- Cloud pure-binary testing shows no new WebSocket lifecycle errors and bounded latest-data delivery under WAN pressure.
- Fault injection still proves MQTT fallback reaches the cloud and browser.
- Local 12-second acceptance remains passing.
