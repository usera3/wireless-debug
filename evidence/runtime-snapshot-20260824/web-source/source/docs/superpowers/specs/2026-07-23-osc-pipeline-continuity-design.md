# Oscilloscope Pipeline Continuity Design

## Baseline

Implementation starts from web commit `b053983` on branch
`fix/osc-continuity-20260723`.

This is the current Wednesday rollback line:

- `589667f` is the restored stable web checkpoint.
- `b053983` adds only the approved cloud parameter oscilloscope WSS uplink.
- The Friday line ending at `0135ffd` is not used because it also contains the
  later request-lifecycle and cleanup changes that were rolled back.

The chart remains the existing uPlot implementation. Smoothie experiments,
authentication changes, transport compression experiments, and unrelated UI
changes are outside this work.

## Evidence

The reference capture is committed as
`fixtures/osc-c52c-local-30s.json.gz`:

- Address: `0xC52C`
- Duration: 30 seconds
- Frame length: 250 bytes
- Channels: 4
- Sample rate: 10 kHz
- Raw bytes: 2,500,761
- Valid oscilloscope frames: 10,002
- CH1 samples: 300,060
- SHA-256: `4557c782316db3206f7f07f9c0e2062ddfae8937993d2511024b2fcb963e36ef`

The controlled cloud replay proved that the browser received the exact byte
stream sent through the cloud server. The cloud queue did not drop data. The
largest losses happen after bytes enter the page:

1. A WebSocket chunk ending in `FF 77 AA` is consumed as unknown Modbus data.
   The following `55` can no longer complete the oscilloscope magic marker.
2. Address history uses browser arrival time as a sample index. Main-thread or
   network jitter is therefore converted into blank waveform rows.
3. Stop clears the realtime batch before the final samples are appended.
4. The page rebuilds and redraws 2,400 points per series from inside frequent
   receive-driven store updates. In the reference run canvas redraw intervals
   averaged about 79 ms and reached a 124 ms P95.

Follow-up browser instrumentation showed that one uPlot draw task has a 1.3 ms
P95 and no long tasks. The remaining unevenness follows browser WebSocket
delivery: even with server pacing configured to 2,048 bytes every 20 ms,
in-page message intervals have a 0.8 ms median, 75.9 ms P95, and 182.6 ms
maximum. TCP/WebSocket scheduling therefore delivers paced server writes in
bursts, and a small consumer-side jitter reserve is required.

## Data Flow

```text
ESP32 byte stream
  -> local/cloud WebSocket message boundaries
  -> FrameRouter byte carry
  -> complete oscilloscope frames
  -> sample parser
  -> local realtime buffer or cloud jitter reserve
  -> sample-rate-paced store flush
  -> contiguous address history
  -> channel-aware point budget
  -> existing uPlot chart
```

Every boundary has one invariant:

- WebSocket to router: message boundaries do not change frame count or order.
- Router to parser: only complete CRC-valid frames are emitted.
- Parser to buffer: every parsed sample is appended once.
- Buffer to history: an ordered `0x72` ACK forms the stop barrier, then all
  pending samples are flushed before cleanup.
- History to chart: address time advances by sample count, not delivery time.
- Chart: render work is bounded by visible series count.

## Design

### Preserve partial oscilloscope magic

When no complete magic marker exists in `FrameRouter.buf`, retain the longest
suffix that is also a prefix of `FF 77 AA 55`. At most three bytes are retained.
Only bytes before that suffix are offered to the Modbus scanner.

This keeps current Modbus recovery behavior while allowing an oscilloscope
header to span any WebSocket boundary. The regression covers one-, two-, and
three-byte marker prefixes, with the three-byte case proving the existing bug.

### Keep address history sample-contiguous

`useOscStore.appendSamples` will append address samples through
`OscHistory.appendBatch`, without forwarding `elapsedMs`. A delayed browser
callback changes when samples become visible but never invents missing sample
indices.

`OscHistory.appendBatchAt` remains available for an explicitly time-positioned
series, and parameter timeout values remain represented by their existing
non-finite/null data. The parameter oscilloscope store and timeout policy are
not changed.

### Separate receive and render cadence

The oscilloscope frame handler only parses frames and appends samples to
`OscRealtimeBuffer`. It does not update Zustand directly.

A single 50 ms interval drains the latest accumulated batch into the store.
This prevents a delayed render from causing the next queued WebSocket event to
synchronously start another render before other queued data can be parsed.

Local ESP32 traffic keeps the direct realtime buffer because it already arrives
smoothly. Cloud address traffic uses a sample-based jitter reserve with a
300 ms initial target and a 100 ms resume threshold after a true underrun. The
consumer advances by sample rate rather than packet timing and caps one delayed
timer catch-up to 100 ms. This is not the old multi-second playback queue: it
adds only the reserve required to cover the measured 183 ms delivery burst and
does not wait another 300 ms after every minor shortage.

The jitter reserve uses indexed queues rather than repeated `splice(0, n)` and
never drops samples. Stop drains all reserved samples into history before
cleanup, so CSV export remains byte/sample complete.

Starting replaces any old flush timer. Stopping first registers a strict
`0x72` response waiter and sends the stop request while parsing and pacing stay
active. Because the device uplink and browser fanout preserve order, receipt of
that ACK means all earlier waveform bytes have reached `FrameRouter`. Only then
does cleanup stop the timer, drain both pending buffers, and clear the handler.
A 2.5 second timeout provides bounded cleanup after a lost connection.

Cloud fast start also sends a preliminary stop without delaying channel setup.
All preliminary, runtime, and start-error stops enter one sequence. The
sequence retains an ACK debt when a request times out; a later waiter must
consume every outstanding ACK plus the ACK for its own `0x72` before cleanup.
If an old ACK never arrives, cleanup uses the existing bounded timeout instead
of treating a newer ACK as proof that every earlier request was acknowledged.
The debt is reset only after the connection target changes and the previous
waiter has settled. Identical ACKs therefore cannot release runtime cleanup
before the current run's final waveform bytes arrive.

Each queued stop also captures the canonical WebSocket target and a monotonic
connection generation. Reconnect, disconnect, and target switch advance that
generation. A deferred stop whose generation is no longer current is marked
superseded before it subscribes or sends, and an active old-generation waiter
ignores new-generation ACKs until its bounded timeout. The controller creates
the next sequence only after old waiters settle, so an old target's deferred
request cannot be transmitted on the new target or create debt there.

### Bound uPlot work by channel count

The visible-history downsampling budget becomes channel-aware:

- Maximum per series: 2,400 points
- Maximum total target: 4,800 points
- Minimum per series: 512 points

For the four-channel reference this produces 1,200 points per series. The
history still uses min/max buckets, so short peaks remain represented. Both
address and parameter oscilloscope pages use the same budget helper; low-series
views retain the old 2,400-point detail.

No chart library, chart interaction, axis behavior, or visual styling changes.

## Verification

Automated verification must prove all of the following:

- A frame whose header is split after `FF 77 AA` is emitted exactly once.
- The 30-second capture produces all 10,002 frame hashes under original,
  2,048-byte, 8,192-byte, and one-chunk boundaries.
- The address store has 200 contiguous samples after two 100-sample batches
  whose simulated receive times are two seconds apart.
- A final split frame delivered after stop is requested is appended before the
  ordered stop ACK allows cleanup.
- A delayed cloud-startup stop ACK, including one arriving after startup
  timeout, pays only the older request's ACK debt and cannot satisfy the
  runtime stop barrier.
- A stop queued on target A is never sent or acknowledged through target B
  after the WebSocket connection generation changes.
- Four visible channels receive a 1,200-point-per-series render budget.
- Cloud jitter playback remains continuous across a simulated 183 ms receive
  gap and drains every source sample on stop.
- Existing frame, Modbus, oscilloscope request, local/cloud transport, and
  parameter regressions continue to pass.
- `npm run build` succeeds.

The browser acceptance replay uses the same 30-second capture and requires:

- Browser raw stream equals input raw stream.
- Router frames: 10,002 of 10,002 in original order.
- Exported CH1 data samples: 300,060.
- Address-history blank rows caused by receive timing: 0.
- Canvas redraw interval mean no greater than 60 ms and P95 no greater than
  80 ms on the same 1,600 x 900 headless Chromium environment.

Cloud assets and ESP32 embedded assets are synchronized only after these checks
pass. Firmware transport code is not changed by this web fix.

## Measured Acceptance

The local production build was replayed for 30 seconds through the deployed
cloud fanout on 2026-07-23. It produced:

- Browser bytes: 2,500,761 of 2,500,761, exact SHA-256 match
- Browser frames: 10,002 of 10,002, exact order/hash match
- Exported CH1 samples: 300,060
- Blank rows and continuity mismatches: 0
- Canvas interval mean: 49.92 ms
- Canvas interval P95: 53.0 ms
- Canvas intervals over 100 ms: 0
- Browser/page errors: 0

The raw browser WebSocket messages remained bursty (0.7 ms median and 76.8 ms
P95), confirming that the stable canvas cadence comes from sample-based jitter
pacing rather than an unobserved transport change.
