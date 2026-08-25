# Oscilloscope Boundary Tolerance and Ordered Rendering Design

## Problem

The deployed ESP32 page loads correctly after restoring the stable web assets.
The first compatibility change made samples visible, but a simultaneous raw
WebSocket and CSV capture showed that the live stream contains two alternating
250-byte block forms:

```text
A: FF 77 AA 55 + 240-byte payload + CRC + 00 00 00 00
B: 5F 05 01 F4 + 240-byte payload + CRC + FF 77 AA 55
```

Both payload CRCs are valid and their samples are contiguous. The current router
accepts only A, so a six-second capture retains about 2.9 seconds of samples. A
captured signed-16-bit wrap changes from `32743` to `-32672` instead of the
complete `32767` to `-32768` transition.

Long-window rendering has a second defect. Each downsampling bucket stores only
its minimum and maximum and always emits minimum first. A bucket containing a
sawtooth wrap has maximum before minimum, so reversing that order creates a
second artificial vertical edge.

The previous recovery attempt mixed this parser change with an incorrectly built
or deployed SPIFFS image. The parser behavior and image production must be fixed
and verified independently.

## Accepted Behavior

An oscilloscope block is accepted when:

1. Its length matches the configured frame length.
2. Its payload CRC is valid.
3. Its header or footer is `FF 77 AA 55`.

The router must recognize a configured-length, footer-anchored B block at the
current buffer position before discarding bytes while searching for a header.
It must not hardcode `5F 05 01 F4` as another magic value. A block whose header
and footer both lack magic is rejected even when its CRC happens to be valid.

The parser follows the same symmetric boundary rule. Existing permissive parser
behavior for a frame with both documented boundaries remains controlled by the
existing `requireCrc` option; a missing boundary always requires a valid CRC.

For rendering, each bucket records the sample indices of its minimum and maximum.
The two extrema are emitted in their original temporal order. This preserves a
single real sawtooth transition while retaining extrema visibility at long time
windows.

## Scope

- Update `FrameRouter` to accept a configured-length block at the current buffer
  position when its CRC is valid and at least one boundary has magic.
- Update `parseOscDataFrame` to apply the same symmetric boundary rule.
- Extend `ChannelHistory.minMaxRange` to return extrema sample positions and make
  `buildMinMaxAlignedData` emit extrema in temporal order.
- Add regression coverage for standard frames, A/B alternating streams, blocks
  with neither boundary, invalid CRCs, and an extrema bucket whose maximum occurs
  before its minimum.
- Do not change the ESP32 application firmware, UART routing, cloud transport,
  frame length, sample format, or unrelated UI behavior.

## Deployment

Build only from the verified web worktree at commit `7edf22b` plus this focused
change. Copy the resulting assets into the firmware asset worktree based on
`a9d2523`. Generate `storage.bin` from the firmware `dist/` root with the exact
SPIFFS options recorded in `build.ninja`, including `--use-magic` and
`--use-magic-len`. Flash only the storage partition at `0x290000`.

## Verification

1. Run the alternating-boundary and ordered-extrema regressions red before
   implementation and green afterward.
2. Run frame-router, oscilloscope transport, stop-barrier, replay, production
   build, and unified-site smoke regressions.
3. Confirm generated web assets match the firmware `dist/orig` copies.
4. After flashing, download `/orig/a.js` completely and compare its SHA-256 with
   the local gzip asset.
5. Open `/orig/i.html` in Playwright and require no page or resource errors.
6. Capture raw WebSocket messages and the CSV from the same CH1 `C52C` run.
   Require every CRC-valid A/B block to be routed and every exported sample to
   match the routed payload sample exactly.
7. Run for at least eight seconds and require cache duration to track wall time,
   the signed-16-bit wrap to retain all adjacent values, and the long-window plot
   to render one temporal wrap edge rather than a duplicated edge.
