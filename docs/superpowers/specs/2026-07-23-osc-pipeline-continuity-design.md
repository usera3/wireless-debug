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

The reference capture is `/tmp/osc-c52c-local-30s.json`:

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

## Data Flow

```text
ESP32 byte stream
  -> local/cloud WebSocket message boundaries
  -> FrameRouter byte carry
  -> complete oscilloscope frames
  -> sample parser
  -> realtime producer buffer
  -> fixed-cadence store flush
  -> contiguous address history
  -> channel-aware point budget
  -> existing uPlot chart
```

Every boundary has one invariant:

- WebSocket to router: message boundaries do not change frame count or order.
- Router to parser: only complete CRC-valid frames are emitted.
- Parser to buffer: every parsed sample is appended once.
- Buffer to history: stop flushes pending samples before cleanup.
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
There is no artificial playback delay. This prevents a delayed render from
causing the next queued WebSocket event to synchronously start another render
before other queued data can be parsed.

Starting replaces any old flush timer. Stopping clears the timer, drains the
pending batch once, appends it, and only then clears the buffer and router
handler. Failed startup keeps the existing rollback behavior and also removes
the timer if it was created.

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
- Stop appends a pending realtime batch before clearing it.
- Four visible channels receive a 1,200-point-per-series render budget.
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

