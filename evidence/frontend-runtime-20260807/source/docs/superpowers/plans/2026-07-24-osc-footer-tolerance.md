# Oscilloscope Boundary Tolerance and Ordered Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve every CRC-valid live oscilloscope block and render long-window extrema in temporal order, without accepting unanchored corrupt data or changing ESP32 application firmware.

**Architecture:** Keep frame acceptance in the existing router and parser. A configured-length block requires a valid payload CRC and magic at either its header or footer. Downsampling keeps min/max values together with their sample positions and emits them in temporal order. Build from the verified Web worktree, embed only generated Web assets into the firmware asset worktree, and flash only the SPIFFS storage partition.

**Tech Stack:** TypeScript, Vite, Node regression scripts, ESP-IDF SPIFFS generator, esptool, Playwright.

## Global Constraints

- Do not change ESP32 application firmware, UART routing, cloud transport, frame length, sample format, or unrelated UI behavior.
- Build Web assets from `/mnt/d/Users/sunqi39/Desktop/.codex-osc-continuity-20260723` based on commit `7edf22b` plus the approved focused changes.
- Embed assets in `/mnt/d/Users/sunqi39/Desktop/.codex-fw-osc-continuity-20260723` based on commit `a9d2523`.
- Generate SPIFFS from the firmware `dist/` root with `--page-size=256 --obj-name-len=32 --meta-len=4 --use-magic --use-magic-len`.
- Flash only `0x290000 storage.bin`; do not flash bootloader, partition table, or app.
- Tasks 1–3 record the completed first deployment checkpoint. Tasks 4–6 continue from that checkpoint after live capture exposed alternating boundary forms and order-reversing downsampling.

---

### Task 1: Accept CRC-valid zero-footer frames

**Files:**
- Modify: `scripts/frame-router-regression.ts`
- Modify: `src/lib/frameRouter.ts:289`
- Modify: `src/lib/oscilloscope.ts:76`

**Interfaces:**
- Consumes: `FrameRouter.feed(data: Uint8Array)`, `parseOscDataFrame(data, channels, options)` and `crc16(payload)`.
- Produces: unchanged public interfaces; only frame acceptance behavior changes.

- [ ] **Step 1: Write the failing router and parser regressions**

Add the parser import:

```ts
import { parseOscDataFrame } from '../src/lib/oscilloscope';
```

Append these cases to `scripts/frame-router-regression.ts`:

```ts
{
  const router = new FrameRouter();
  const frames: Uint8Array[] = [];
  const oscFrame = makeOscFrame(250);
  oscFrame.fill(0, 246, 250);

  router.setFrameLen(250);
  router.onOscFrame((frame) => frames.push(frame));
  router.feed(oscFrame);

  assert.equal(frames.length, 1, 'valid CRC must allow a zero osc footer');
  assert.equal(hex(frames[0]), hex(oscFrame));
}

{
  const oscFrame = makeOscFrame(250);
  oscFrame.fill(0, 246, 250);
  const parsed = parseOscDataFrame(
    oscFrame,
    [{ byteWidth: 2, paramType: 0x00 }],
    { requireCrc: true },
  );

  assert.notEqual(parsed, null, 'parser must accept a zero footer when CRC is valid');
  assert.equal(parsed?.rawData.length, 240);
}

{
  const router = new FrameRouter();
  const frames: Uint8Array[] = [];
  const oscFrame = corruptOscCrc(makeOscFrame(250));
  oscFrame.fill(0, 246, 250);

  router.setFrameLen(250);
  router.onOscFrame((frame) => frames.push(frame));
  router.feed(oscFrame);

  assert.equal(frames.length, 0, 'zero footer must not bypass an invalid CRC');
  assert.equal(
    parseOscDataFrame(oscFrame, [{ byteWidth: 2, paramType: 0x00 }]),
    null,
    'parser must reject a frame when both CRC and footer are invalid',
  );
}
```

- [ ] **Step 2: Run the regression and verify RED**

Run:

```bash
npm run test:frame-router
```

Expected: FAIL at `valid CRC must allow a zero osc footer` because the current router requires tail magic.

- [ ] **Step 3: Implement the minimal router change**

Replace `FrameRouter.isValidOscFrameLen` with:

```ts
private isValidOscFrameLen(frameLen: number): boolean {
  if (frameLen < OSC_MIN_FRAME_LEN || this.buf.length < frameLen) return false;
  if (!matchMagic(this.buf, 0)) return false;
  const crcOffset = frameLen - MAGIC_LEN - 2;
  return verifyCrc(this.buf.slice(MAGIC_LEN, crcOffset + 2));
}
```

- [ ] **Step 4: Implement the minimal parser change**

Remove the early footer rejection. After calculating `crcValid`, add:

```ts
const footerValid = MAGIC.every(
  (byte, index) => data[data.length - FOOTER_LEN + index] === byte,
);
if (!crcValid && (options.requireCrc || !footerValid)) return null;
```

This accepts a missing footer only with a valid CRC. It retains the prior behavior where `requireCrc: false` permits a bad CRC only when the documented footer is intact.

- [ ] **Step 5: Run focused and adjacent regressions**

Run:

```bash
npm run test:frame-router
npm run test:osc-transport
npm run test:osc-stop-barrier
npm run test:ws-client-generation
```

Expected: all commands exit 0; the stop-barrier and transport scripts print their `passed` messages.

- [ ] **Step 6: Commit the behavior change**

```bash
git add scripts/frame-router-regression.ts src/lib/frameRouter.ts src/lib/oscilloscope.ts
git commit -m "fix: accept crc-valid osc frames without footer"
```

---

### Task 2: Build and embed deterministic Web assets

**Files:**
- Generated: `dist/a.css`, `dist/a.css.gz`, `dist/a.js`, `dist/a.js.gz`, `dist/x.js`, `dist/x.js.gz`, `dist/index.html`, `dist/index.html.gz`
- Modify in firmware asset worktree: `dist/orig/a.css`, `dist/orig/a.css.gz`, `dist/orig/a.js`, `dist/orig/a.js.gz`, `dist/orig/x.js`, `dist/orig/x.js.gz`

**Interfaces:**
- Consumes: Task 1 parser behavior and Vite build configuration.
- Produces: firmware `dist/orig` assets consumed by SPIFFS generation in Task 3.

- [ ] **Step 1: Run replay, build, and site smoke verification**

```bash
npm run test:osc-pipeline-replay
npm run test:osc-realtime-buffer
npm run test:unified-smoke
```

Expected: replay reports `10002` frames and `300060` CH1 samples for every chunking mode; all commands exit 0; smoke prints `unified site smoke passed`.

- [ ] **Step 2: Copy only generated assets into the firmware asset worktree**

From the Web worktree:

```bash
for file in a.css a.css.gz a.js a.js.gz x.js x.js.gz; do
  cp "dist/$file" "/mnt/d/Users/sunqi39/Desktop/.codex-fw-osc-continuity-20260723/dist/orig/$file"
done
```

Keep the committed firmware `dist/orig/i.html` and `i.html.gz`; the Vite build names the equivalent entry `index.html`.

- [ ] **Step 3: Verify source/output and firmware copies byte-for-byte**

```bash
for file in a.css a.css.gz a.js a.js.gz x.js x.js.gz; do
  cmp "dist/$file" "/mnt/d/Users/sunqi39/Desktop/.codex-fw-osc-continuity-20260723/dist/orig/$file"
done
git -C /mnt/d/Users/sunqi39/Desktop/.codex-fw-osc-continuity-20260723 diff --check
```

Expected: every `cmp` exits 0 and `git diff --check` prints nothing.

- [ ] **Step 4: Commit embedded assets in the firmware worktree**

```bash
git -C /mnt/d/Users/sunqi39/Desktop/.codex-fw-osc-continuity-20260723 add dist/orig
git -C /mnt/d/Users/sunqi39/Desktop/.codex-fw-osc-continuity-20260723 commit -m "chore: embed osc footer-tolerant web assets"
```

---

### Task 3: Generate, flash, and verify SPIFFS

**Files:**
- Generate: `/mnt/d/Users/sunqi39/Desktop/.codex-fw-osc-continuity-20260723/build/storage.bin`
- Read-only verify: board `/orig/i.html`, `/orig/a.js`, `/api/device/status`

**Interfaces:**
- Consumes: Task 2 firmware `dist/` tree.
- Produces: a verified storage partition on the ESP32-S3 at offset `0x290000`.

- [ ] **Step 1: Generate SPIFFS with the firmware build parameters**

```bash
cmd.exe /C "D:\Users\sunqi39\.espressif\python_env\idf6.0_py3.11_env\Scripts\python.exe C:\esp\v6.0\esp-idf\components\spiffs\spiffsgen.py 0x570000 D:\Users\sunqi39\Desktop\.codex-fw-osc-continuity-20260723\dist D:\Users\sunqi39\Desktop\.codex-fw-osc-continuity-20260723\build\storage.bin --page-size=256 --obj-name-len=32 --meta-len=4 --use-magic --use-magic-len"
```

Expected: `build/storage.bin` is exactly `5701632` bytes.

- [ ] **Step 2: Confirm the board ROM connection before writing**

With the bootloader jumper installed and the board reset:

```bash
cmd.exe /C "D:\Users\sunqi39\.espressif\python_env\idf6.0_py3.11_env\Scripts\python.exe -m esptool --chip esp32s3 -p COM4 -b 115200 chip-id"
```

Expected: `Connected to ESP32-S3 on COM4` and MAC `ac:27:6e:ab:7c:9c`.

- [ ] **Step 3: Flash only storage**

```bash
cmd.exe /C "cd /D D:\Users\sunqi39\Desktop\.codex-fw-osc-continuity-20260723\build && D:\Users\sunqi39\.espressif\python_env\idf6.0_py3.11_env\Scripts\python.exe -m esptool --chip esp32s3 -p COM4 -b 460800 --before default-reset --after hard-reset write-flash --flash-mode dio --flash-freq 80m --flash-size 8MB 0x290000 storage.bin"
```

Expected: `Wrote 5701632 bytes`, `Hash of data verified`, and `Hard resetting via RTS pin`.

- [ ] **Step 4: Remove the bootloader jumper, reset, and verify static assets**

After the user removes the jumper and resets, run:

```bash
curl --noproxy '*' -sS --connect-timeout 3 --max-time 30 \
  -H "Accept-Encoding: gzip" -o /tmp/wd_board_a.js.gz \
  http://192.168.4.1/orig/a.js
cmp /tmp/wd_board_a.js.gz \
  /mnt/d/Users/sunqi39/Desktop/.codex-fw-osc-continuity-20260723/dist/orig/a.js.gz
```

Expected: curl exits 0, downloaded size equals local `a.js.gz`, and `cmp` exits 0.

- [ ] **Step 5: Verify page rendering and the original live symptom**

Use Playwright with direct/no-proxy Chromium to open `http://192.168.4.1/orig/i.html`. Require:

```text
#root innerHTML length > 0
page errors = 0
failed resource requests = 0
```

Open address oscilloscope, set the first address input to `C52C`, start, wait at least eight seconds, and require:

```text
状态: 运行中
缓存 duration > 0s
retained samples > 0
CH1 tooltip value is numeric
```

Stop the oscilloscope before closing the browser and save a full-page screenshot to `/tmp/wd-footer-tolerant-address-osc.png`.

- [ ] **Step 6: Final repository and device-state check**

```bash
git -C /mnt/d/Users/sunqi39/Desktop/.codex-osc-continuity-20260723 status --short
git -C /mnt/d/Users/sunqi39/Desktop/.codex-fw-osc-continuity-20260723 status --short
curl --noproxy '*' -sS http://192.168.4.1/api/device/status
```

Expected: both worktrees are clean and the device status returns `"ok":true` with no new transport failure counters from the short validation run.

---

### Task 4: Recover header-anchored and footer-anchored blocks

**Files:**
- Modify: `scripts/frame-router-regression.ts`
- Modify: `src/lib/frameRouter.ts:135-170,289-295`
- Modify: `src/lib/oscilloscope.ts:72-98`

**Interfaces:**
- Consumes: configured `frameLen`, payload CRC, and `FF 77 AA 55` boundary magic.
- Produces: unchanged `FrameRouter` and `parseOscDataFrame` public APIs; both A and B live block forms produce one parsed frame.

- [ ] **Step 1: Add failing alternating-boundary regressions**

Add this helper and cases to `scripts/frame-router-regression.ts`:

```ts
function makeFooterAnchoredOscFrame(frameLen: number): Uint8Array {
  const frame = makeOscFrame(frameLen);
  frame.set([0x5f, 0x05, 0x01, 0xf4], 0);
  return frame;
}

{
  const router = new FrameRouter();
  const frames: Uint8Array[] = [];
  const headerAnchored = makeOscFrame(250);
  headerAnchored.fill(0, 246, 250);
  const footerAnchored = makeFooterAnchoredOscFrame(250);

  router.setFrameLen(250);
  router.onOscFrame((frame) => frames.push(frame));
  router.feed(headerAnchored);
  router.feed(footerAnchored);

  assert.equal(frames.length, 2, 'alternating valid boundary blocks must both be routed');
  assert.notEqual(
    parseOscDataFrame(footerAnchored, [{ byteWidth: 2, paramType: 0x00 }], { requireCrc: true }),
    null,
    'parser must accept a CRC-valid footer-anchored block',
  );
}

{
  const router = new FrameRouter();
  const frames: Uint8Array[] = [];
  const unanchored = makeOscFrame(250);
  unanchored.fill(0, 0, 4);
  unanchored.fill(0, 246, 250);

  router.setFrameLen(250);
  router.onOscFrame((frame) => frames.push(frame));
  router.feed(unanchored);

  assert.equal(frames.length, 0, 'CRC alone must not accept an unanchored block');
  assert.equal(
    parseOscDataFrame(unanchored, [{ byteWidth: 2, paramType: 0x00 }]),
    null,
    'parser must reject a block with neither boundary',
  );
}
```

- [ ] **Step 2: Run the router regression and verify RED**

```bash
npm run test:frame-router
```

Expected: FAIL at `alternating valid boundary blocks must both be routed` with one routed block instead of two.

- [ ] **Step 3: Recognize a configured valid block before header scanning**

In `FrameRouter.tryConsume`, replace the direct header search with:

```ts
const configuredFrameAtStart = this.isValidOscFrameLen(this.frameLen);
const headerPos = configuredFrameAtStart ? 0 : this.findMagic(0);
```

Replace `isValidOscFrameLen` boundary validation with:

```ts
const headerValid = matchMagic(this.buf, 0);
const footerValid = matchMagic(this.buf, frameLen - MAGIC_LEN);
if (!headerValid && !footerValid) return false;
```

Keep the existing CRC validation unchanged.

- [ ] **Step 4: Apply the same symmetric rule in the parser**

Compute `headerValid` instead of returning during the header loop, retain the existing `footerValid`, and reject with:

```ts
if (!headerValid && !footerValid) return null;
if (!crcValid && (options.requireCrc || !headerValid || !footerValid)) return null;
```

- [ ] **Step 5: Run focused and adjacent regressions**

```bash
npm run test:frame-router
npm run test:osc-transport
npm run test:osc-stop-barrier
npm run test:osc-pipeline-replay
```

Expected: all commands exit 0 and the replay retains `10002` frames in every chunking mode.

- [ ] **Step 6: Commit symmetric boundary recovery**

```bash
git add scripts/frame-router-regression.ts src/lib/frameRouter.ts src/lib/oscilloscope.ts
git commit -m "fix: recover footer-anchored osc blocks"
```

---

### Task 5: Preserve extrema order during long-window downsampling

**Files:**
- Create: `scripts/osc-history-render-order-regression.ts`
- Modify: `package.json`
- Modify: `src/lib/oscHistory.ts:112-125,315-343`

**Interfaces:**
- Consumes: `OscHistory.appendBatch` and `OscHistory.buildAlignedData`.
- Produces: `ChannelHistory.minMaxRange` returns `{ min, max, minSampleIndex, maxSampleIndex }`; the public aligned-data shape remains unchanged.

- [ ] **Step 1: Add a failing temporal-order regression**

Create `scripts/osc-history-render-order-regression.ts`:

```ts
import { strict as assert } from 'node:assert';
import { OscHistory } from '../src/lib/oscHistory';

const history = new OscHistory();
history.reset([1], 1_000, 10);
const values = Array.from({ length: 128 }, (_, index) => index);
values.splice(0, 4, 100, 50, -100, 0);
history.appendBatch(new Map([[1, values]]));

const data = history.buildAlignedData([1], 0, 0.128, 64);
assert.deepEqual(
  data[1].slice(0, 2),
  [100, -100],
  'a bucket must emit max before min when that is their temporal order',
);
console.log('osc history render order regression passed');
```

Add to `package.json`:

```json
"test:osc-history-render-order": "esbuild scripts/osc-history-render-order-regression.ts --bundle --platform=node --format=esm --outfile=node_modules/.tmp/osc-history-render-order-regression.mjs && node node_modules/.tmp/osc-history-render-order-regression.mjs"
```

- [ ] **Step 2: Run the order regression and verify RED**

```bash
npm run test:osc-history-render-order
```

Expected: FAIL because current output is `[-100, 100]`.

- [ ] **Step 3: Record extrema sample positions**

Change `minMaxRange` to return positions and update them with the extrema:

```ts
minMaxRange(startInclusive: number, endExclusive: number): {
  min: number;
  max: number;
  minSampleIndex: number;
  maxSampleIndex: number;
} | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let minSampleIndex = -1;
  let maxSampleIndex = -1;
  this.forEachRange(startInclusive, endExclusive, (value, sampleIndex) => {
    if (!Number.isFinite(value)) return;
    if (value < min) {
      min = value;
      minSampleIndex = sampleIndex;
    }
    if (value > max) {
      max = value;
      maxSampleIndex = sampleIndex;
    }
  });
  if (minSampleIndex < 0 || maxSampleIndex < 0) return null;
  return { min, max, minSampleIndex, maxSampleIndex };
}
```

- [ ] **Step 4: Emit extrema in temporal order**

In `buildMinMaxAlignedData`, replace fixed min/max assignment with:

```ts
const minFirst = range.minSampleIndex <= range.maxSampleIndex;
out[pointOffset] = minFirst ? range.min : range.max;
if (bucketEnd - 1 !== bucketStart) {
  out[pointOffset + 1] = minFirst ? range.max : range.min;
}
```

- [ ] **Step 5: Run rendering and history regressions**

```bash
npm run test:osc-history-render-order
npm run test:osc-realtime-buffer
npm run test:osc-render-budget
npm run test:osc-jitter-buffer
```

Expected: all commands exit 0 and print their `passed` messages.

- [ ] **Step 6: Commit ordered downsampling**

```bash
git add package.json scripts/osc-history-render-order-regression.ts src/lib/oscHistory.ts
git commit -m "fix: preserve osc extrema time order"
```

---

### Task 6: Rebuild, redeploy, and measure fidelity

**Files:**
- Generated Web assets under `dist/`
- Modified firmware assets under `/mnt/d/Users/sunqi39/Desktop/.codex-fw-osc-continuity-20260723/dist/orig/`
- Generated firmware image: `/mnt/d/Users/sunqi39/Desktop/.codex-fw-osc-continuity-20260723/build/storage.bin`

**Interfaces:**
- Consumes: Tasks 4 and 5.
- Produces: a storage-only deployment and raw-to-CSV fidelity report.

- [ ] **Step 1: Run full focused verification and production smoke**

```bash
npm run test:frame-router
npm run test:osc-history-render-order
npm run test:osc-pipeline-replay
npm run test:unified-smoke
```

Expected: all commands exit 0; replay retains `10002` frames in every mode; smoke passes.

- [ ] **Step 2: Copy and commit the final generated assets**

Copy `a.css`, `a.css.gz`, `a.js`, `a.js.gz`, `x.js`, and `x.js.gz` from Web `dist/` to firmware `dist/orig/`, verify each with `cmp`, then commit:

```bash
git -C /mnt/d/Users/sunqi39/Desktop/.codex-fw-osc-continuity-20260723 add dist/orig
git -C /mnt/d/Users/sunqi39/Desktop/.codex-fw-osc-continuity-20260723 commit -m "chore: embed full osc fidelity assets"
```

- [ ] **Step 3: Generate and flash only storage**

Use the exact SPIFFS and esptool commands from Task 3. Require image size `5701632`, successful ESP32-S3 `chip-id`, `Hash of data verified`, and no writes outside `0x290000`.

- [ ] **Step 4: Verify asset identity and browser health**

After removing the bootloader jumper and resetting, compare board `/orig/a.js` gzip bytes with firmware `dist/orig/a.js.gz`. Open `/orig/i.html` in direct/no-proxy Playwright and require zero resource or page errors.

- [ ] **Step 5: Capture one-channel raw data and CSV from the same run**

Run CH1 `C52C` for at least 12 wall-clock seconds. Capture each WebSocket binary message through CDP, export CSV after stopping, and replay the captured message boundaries through the project `FrameRouter` and `parseOscDataFrame`. Require:

```text
all CRC-valid blocks with header or footer magic are routed
CSV sample count equals routed sample count
CSV mismatches = 0
matchPercent = 100
cache duration / wall duration >= 0.95
```

- [ ] **Step 6: Verify long-window rendering**

Use at least 100,000 retained samples so min/max downsampling is active. Confirm a signed-16-bit wrap contains adjacent `32767, -32768` values in CSV and one corresponding vertical edge in `/tmp/wd-full-fidelity-address-osc.png`, without a second adjacent edge.

- [ ] **Step 7: Verify clean repositories and device counters**

Require both worktrees clean. Read `/api/device/status` and require UART RX bytes equal Wi-Fi queued/sent bytes for the validation interval, with zero UART TX failures, Wi-Fi TX failures, pool exhaustion, queue full, and router drops.
