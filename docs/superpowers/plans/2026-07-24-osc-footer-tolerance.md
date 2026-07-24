# Oscilloscope Footer Tolerance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render live address-oscilloscope samples whose frames have a valid header and payload CRC but a zero footer, without accepting corrupt frames or changing ESP32 application firmware.

**Architecture:** Keep frame acceptance in the existing router and parser. The router always requires a valid payload CRC; the parser accepts a missing footer only when the CRC is valid and preserves its existing `requireCrc` behavior for frames whose footer is valid. Build from the verified Web worktree, embed only generated Web assets into the firmware asset worktree, and flash only the SPIFFS storage partition.

**Tech Stack:** TypeScript, Vite, Node regression scripts, ESP-IDF SPIFFS generator, esptool, Playwright.

## Global Constraints

- Do not change ESP32 application firmware, UART routing, cloud transport, frame length, sample format, or unrelated UI behavior.
- Build Web assets from `/mnt/d/Users/sunqi39/Desktop/.codex-osc-continuity-20260723` based on commit `7edf22b` plus the approved focused changes.
- Embed assets in `/mnt/d/Users/sunqi39/Desktop/.codex-fw-osc-continuity-20260723` based on commit `a9d2523`.
- Generate SPIFFS from the firmware `dist/` root with `--page-size=256 --obj-name-len=32 --meta-len=4 --use-magic --use-magic-len`.
- Flash only `0x290000 storage.bin`; do not flash bootloader, partition table, or app.

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

