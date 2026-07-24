# Oscilloscope Footer Tolerance Design

## Problem

The deployed ESP32 page loads correctly after restoring the stable web assets, but
the address oscilloscope receives about 78 KB/s while retaining zero samples.
Live frames have the expected `FF 77 AA 55` header and a valid payload CRC, but
their four-byte footer is zero instead of the documented magic value. The stable
frontend rejects every such frame before parsing it.

The previous recovery attempt mixed this parser change with an incorrectly built
or deployed SPIFFS image. The parser behavior and image production must be fixed
and verified independently.

## Accepted Behavior

An oscilloscope frame is accepted when:

1. Its length matches the configured frame length.
2. Its header is `FF 77 AA 55`.
3. Its payload CRC is valid.

The footer remains preferred but is not required when the CRC is valid. A frame
with both an invalid CRC and a missing footer is rejected. Existing permissive
parser behavior for a valid footer remains controlled by the existing
`requireCrc` option; the frame router itself continues to require a valid CRC.

## Scope

- Update `FrameRouter` validation to accept a missing footer only through the
  existing CRC check.
- Update `parseOscDataFrame` to accept valid-CRC frames with a missing footer.
- Add regression coverage for standard footer frames, zero-footer valid-CRC
  frames, and zero-footer invalid-CRC frames.
- Do not change the ESP32 application firmware, UART routing, cloud transport,
  frame length, sample format, or unrelated UI behavior.

## Deployment

Build only from the verified web worktree at commit `7edf22b` plus this focused
change. Copy the resulting assets into the firmware asset worktree based on
`a9d2523`. Generate `storage.bin` from the firmware `dist/` root with the exact
SPIFFS options recorded in `build.ninja`, including `--use-magic` and
`--use-magic-len`. Flash only the storage partition at `0x290000`.

## Verification

1. Run the footer regression red before implementation and green afterward.
2. Run frame-router, oscilloscope transport, stop-barrier, replay, production
   build, and unified-site smoke regressions.
3. Confirm generated web assets match the firmware `dist/orig` copies.
4. After flashing, download `/orig/a.js` completely and compare its SHA-256 with
   the local gzip asset.
5. Open `/orig/i.html` in Playwright and require no page or resource errors.
6. Run the address oscilloscope with CH1 `C52C` for at least eight seconds and
   require nonzero retained samples, growing cache duration, and a rendered
   waveform.

