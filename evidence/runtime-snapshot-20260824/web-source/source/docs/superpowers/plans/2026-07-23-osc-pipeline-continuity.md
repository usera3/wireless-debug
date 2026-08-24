# Oscilloscope Pipeline Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve every valid oscilloscope frame and sample across cloud WebSocket boundaries while making the existing uPlot display update at a stable bounded cadence.

**Architecture:** Keep the Wednesday stable web baseline and existing raw WSS transport. Repair byte carry in `FrameRouter`, make address history sample-count based, drain the realtime buffer on stop, and decouple receive handling from a channel-aware uPlot render budget.

**Tech Stack:** React 18, TypeScript 5.6, Zustand 5, uPlot 1.6, Vite 5, Node regression scripts built with esbuild.

## Global Constraints

- Baseline is web commit `b053983` and its parent `589667f`.
- Keep the existing uPlot chart; do not add Smoothie or another chart library.
- Do not add authentication or other security behavior.
- Do not change cloud transport configuration or ESP32 transport code.
- Cloud address playback may use only the measured 300 ms jitter reserve; do
  not restore the previous multi-second playback queue.
- Preserve parameter timeout-gap behavior and parameter-table behavior.
- Use the checksum-pinned `fixtures/osc-c52c-local-30s.json.gz` as the 30-second
  `0xC52C` golden capture.

---

### Task 1: Preserve Oscilloscope Magic Across WebSocket Boundaries

**Files:**
- Modify: `scripts/frame-router-regression.ts`
- Modify: `src/lib/frameRouter.ts`
- Create: `scripts/osc-pipeline-replay.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `FrameRouter.feed(chunk: Uint8Array)` and the capture schema's `chunks` and `analysis.logical_frame_hashes_sha256` fields.
- Produces: `trailingMagicPrefixLength(data: Uint8Array): number` as a private module helper and `npm run test:osc-pipeline-replay`.

- [ ] **Step 1: Add the failing split-marker regression**

Append a case to `scripts/frame-router-regression.ts` that feeds the first
three bytes of a valid oscilloscope frame separately:

```ts
{
  const router = new FrameRouter();
  const frames: Uint8Array[] = [];
  const oscFrame = makeOscFrame(250);

  router.setFrameLen(250);
  router.onOscFrame((frame) => frames.push(frame));
  router.feed(oscFrame.slice(0, 3));
  router.feed(oscFrame.slice(3));

  assert.equal(frames.length, 1,
    'FF 77 AA at the end of one WebSocket message must join 55 in the next message');
  assert.equal(hex(frames[0]), hex(oscFrame));
}
```

- [ ] **Step 2: Run the regression and verify RED**

Run: `npm run test:frame-router`

Expected: FAIL with `frames.length` equal to `0` instead of `1`.

- [ ] **Step 3: Preserve the longest magic prefix**

Add this helper near `matchMagic`:

```ts
function trailingMagicPrefixLength(data: Uint8Array): number {
  for (let length = Math.min(MAGIC_LEN - 1, data.length); length > 0; length--) {
    const start = data.length - length;
    let matches = true;
    for (let index = 0; index < length; index++) {
      if (data[start + index] !== OSC_MAGIC[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return length;
  }
  return 0;
}
```

In the `headerPos < 0` branch, dispatch only the portion before that suffix:

```ts
const preservedBytes = trailingMagicPrefixLength(this.buf);
const dispatchEnd = this.buf.length - preservedBytes;
const consumed = this.dispatchModbus(this.buf.slice(0, dispatchEnd));
this.buf = this.buf.slice(consumed);
```

- [ ] **Step 4: Run frame-router regression and verify GREEN**

Run: `npm run test:frame-router`

Expected: PASS with exit code 0.

- [ ] **Step 5: Add the reusable 30-second replay**

Create `scripts/osc-pipeline-replay.ts` from the existing diagnostic replay.
For each of `original`, `2048-byte`, `8192-byte`, and `one-chunk` boundaries:

```ts
assert.equal(frameHashes.length, expectedHashes.length, `${name}: frame count`);
assert.deepEqual(frameHashes, expectedHashes, `${name}: frame order/hash`);
assert.equal(parsedSamples, 300_060, `${name}: CH1 sample count`);
```

Append batches with `history.appendBatch(drained.batch)` and always drain the
last pending batch before assertions. Add this package script:

```json
"test:osc-pipeline-replay": "esbuild scripts/osc-pipeline-replay.ts --bundle --platform=node --format=esm --outfile=node_modules/.tmp/osc-pipeline-replay.mjs && node node_modules/.tmp/osc-pipeline-replay.mjs"
```

- [ ] **Step 6: Run the golden replay**

Run: `npm run test:osc-pipeline-replay`

Expected: all four boundary modes report 10,002 frames, 300,060 CH1 samples,
zero hash mismatches, and zero history null samples.

- [ ] **Step 7: Commit the parser fix**

```bash
git add package.json scripts/frame-router-regression.ts scripts/osc-pipeline-replay.ts src/lib/frameRouter.ts
git commit -m "fix: preserve osc frames across websocket chunks"
```

### Task 2: Make Address History Contiguous and Drain Stop Tail

**Files:**
- Modify: `scripts/osc-real-time-axis-regression.ts`
- Modify: `scripts/osc-fast-start-regression.ts`
- Modify: `src/store/oscStore.ts`
- Modify: `src/hooks/useOscController.ts`

**Interfaces:**
- Consumes: `useOscStore.getState().appendSamples(batch, elapsedMs?)`, `OscRealtimeBuffer.drain(receivedAt)`, and the existing controller `stop()` callback.
- Produces: address history indexed only by sample count and a stop path that appends the final drained batch before `oscBuffer.clear()`.

- [ ] **Step 1: Add the failing address-store continuity test**

Extend `scripts/osc-real-time-axis-regression.ts`:

```ts
const addressStore = useOscStore.getState();
const channel = { channelNo: 1, varAddr: 0xc52c, paramType: 0, label: 'CH1', byteWidth: 2 };
addressStore.resetHistory([channel], 1000);
addressStore.appendSamples(new Map([[1, Array.from({ length: 100 }, (_, i) => i)]]), 100);
addressStore.appendSamples(new Map([[1, Array.from({ length: 100 }, (_, i) => i + 100)]]), 2100);

const addressStats = useOscStore.getState().historyStats;
assert.equal(addressStats.latestSampleIndex, 200);
assert.equal(oscHistory.exportColumns([1]).columns[0].filter((value) => value == null).length, 0);
```

- [ ] **Step 2: Run the axis regression and verify RED**

Run: `npm run test:osc-real-time-axis`

Expected: FAIL because `latestSampleIndex` is `2100`.

- [ ] **Step 3: Stop forwarding receive time into address history**

Change the address store implementation to:

```ts
appendSamples: (batch) => {
  if (batch.size === 0) return;
  oscHistory.appendBatch(batch);
  const stats = oscHistory.getStats();
  set({ historyStats: stats, historyVersion: stats.version });
},
```

Keep the optional argument in the public type during this change so existing
call sites and captured diagnostics remain source-compatible.

- [ ] **Step 4: Run the axis regression and verify GREEN**

Run: `npm run test:osc-real-time-axis`

Expected: PASS, with 200 address samples and no timing-created null rows.

- [ ] **Step 5: Add the failing stop-drain source regression**

Extend `scripts/osc-fast-start-regression.ts` with an ordering assertion:

```ts
const stopBody = source.match(/const stop = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[/)?.[1] ?? '';
const drainAt = stopBody.indexOf('oscBuffer.drain(performance.now())');
const appendAt = stopBody.indexOf('appendSamples(drained.batch)');
const clearAt = stopBody.indexOf('oscBuffer.clear()');
assert.ok(drainAt >= 0 && appendAt > drainAt && clearAt > appendAt,
  'stop must append the final realtime batch before clearing it');
```

- [ ] **Step 6: Run the stop regression and verify RED**

Run: `npm run test:osc-fast-start`

Expected: FAIL because the current stop body clears without draining.

- [ ] **Step 7: Drain before cleanup**

In the controller stop callback, after stopping the flush timer and before
clearing the buffer, add:

```ts
const drained = oscBuffer.drain(performance.now());
if (drained) appendSamples(drained.batch);
oscBuffer.clear();
```

Add `appendSamples` to the callback dependency list.

- [ ] **Step 8: Run both continuity regressions**

Run: `npm run test:osc-real-time-axis`

Expected: PASS.

Run: `npm run test:osc-fast-start`

Expected: PASS.

- [ ] **Step 9: Commit history and stop behavior**

```bash
git add scripts/osc-real-time-axis-regression.ts scripts/osc-fast-start-regression.ts src/store/oscStore.ts src/hooks/useOscController.ts
git commit -m "fix: keep address samples contiguous through stop"
```

### Task 3: Decouple Receive Parsing From uPlot Rendering

**Files:**
- Modify: `scripts/osc-fast-start-regression.ts`
- Modify: `src/hooks/useOscController.ts`
- Create: `scripts/osc-render-budget-regression.ts`
- Create: `src/lib/oscRenderBudget.ts`
- Modify: `src/components/OscilloscoperPage.tsx`
- Modify: `src/components/ModbusOscPage.tsx`
- Modify: `package.json`

**Interfaces:**
- Consumes: parsed per-channel sample arrays and visible series count.
- Produces: one `setInterval`-driven store flush every 50 ms and `oscPlotPointBudget(seriesCount: number): number`.

- [ ] **Step 1: Add the failing receive/render separation assertion**

Extend `scripts/osc-fast-start-regression.ts`:

```ts
const handlerBody = source.match(/frameRouter\.onOscFrame\(\(frame\) => \{([\s\S]*?)\n      \}\);/)?.[1] ?? '';
assert.doesNotMatch(handlerBody, /appendSamples\(/,
  'WebSocket frame handling must not synchronously update the chart store');
assert.match(source, /setInterval\([\s\S]{0,500}oscBuffer\.drain\(performance\.now\(\)\)[\s\S]{0,500}, STORE_FLUSH_INTERVAL_MS\)/,
  'a fixed-cadence timer must drain the realtime buffer');
```

- [ ] **Step 2: Run the controller regression and verify RED**

Run: `npm run test:osc-fast-start`

Expected: FAIL because the current frame handler calls `appendSamples`.

- [ ] **Step 3: Add a single fixed-cadence flush timer**

Add module state and helpers in `useOscController.ts`:

```ts
let storeFlushTimer: ReturnType<typeof setInterval> | null = null;

function stopStoreFlushTimer() {
  if (!storeFlushTimer) return;
  clearInterval(storeFlushTimer);
  storeFlushTimer = null;
}

function startStoreFlushTimer(appendSamples: (batch: Map<number, number[]>) => void) {
  stopStoreFlushTimer();
  storeFlushTimer = setInterval(() => {
    const drained = oscBuffer.drain(performance.now());
    if (drained) appendSamples(drained.batch);
  }, STORE_FLUSH_INTERVAL_MS);
}
```

Remove `shouldFlush` and `appendSamples` from the frame handler. Reset the
buffer, register the handler, and start the timer before sending `buildStartOsc()`.
Stop the timer before the Task 2 final drain.

- [ ] **Step 4: Run the controller regression and verify GREEN**

Run: `npm run test:osc-fast-start`

Expected: PASS.

- [ ] **Step 5: Add the failing point-budget regression**

Create `scripts/osc-render-budget-regression.ts`:

```ts
import { strict as assert } from 'node:assert';
import { oscPlotPointBudget } from '../src/lib/oscRenderBudget';

assert.equal(oscPlotPointBudget(1), 2400);
assert.equal(oscPlotPointBudget(4), 1200);
assert.equal(oscPlotPointBudget(12), 512);
assert.equal(oscPlotPointBudget(0), 2400);
console.log('osc render budget regression passed');
```

Add package script:

```json
"test:osc-render-budget": "esbuild scripts/osc-render-budget-regression.ts --bundle --platform=node --format=esm --outfile=node_modules/.tmp/osc-render-budget-regression.mjs && node node_modules/.tmp/osc-render-budget-regression.mjs"
```

- [ ] **Step 6: Run the budget regression and verify RED**

Run: `npm run test:osc-render-budget`

Expected: build failure because `src/lib/oscRenderBudget.ts` does not exist.

- [ ] **Step 7: Implement and connect the budget**

Create `src/lib/oscRenderBudget.ts`:

```ts
const MAX_POINTS_PER_SERIES = 2400;
const MIN_POINTS_PER_SERIES = 512;
const TARGET_TOTAL_POINTS = 4800;

export function oscPlotPointBudget(seriesCount: number): number {
  const count = Number.isFinite(seriesCount) && seriesCount > 0
    ? Math.floor(seriesCount)
    : 1;
  return Math.max(
    MIN_POINTS_PER_SERIES,
    Math.min(MAX_POINTS_PER_SERIES, Math.floor(TARGET_TOTAL_POINTS / count)),
  );
}
```

Import it in both oscilloscope pages and replace the literal `2400` passed to
`buildAlignedData` with `oscPlotPointBudget(channelNos.length)`.

- [ ] **Step 8: Run rendering regressions**

Run: `npm run test:osc-render-budget`

Expected: PASS.

Run: `npm run test:osc-fast-start`

Expected: PASS.

- [ ] **Step 9: Commit rendering cadence**

```bash
git add package.json scripts/osc-fast-start-regression.ts scripts/osc-render-budget-regression.ts src/hooks/useOscController.ts src/lib/oscRenderBudget.ts src/components/OscilloscoperPage.tsx src/components/ModbusOscPage.tsx
git commit -m "perf: bound oscilloscope render cadence"
```

### Task 4: Pace Bursty Cloud Samples With a Bounded Jitter Reserve

**Files:**
- Create: `scripts/osc-jitter-buffer-regression.ts`
- Create: `src/lib/oscJitterBuffer.ts`
- Modify: `scripts/osc-fast-start-regression.ts`
- Modify: `src/hooks/useOscController.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: parsed cloud batches, configured channel numbers, sample rate, and
  `performance.now()` ticks.
- Produces: `OscJitterBuffer.reset(options)`, `appendBatch(batch)`,
  `drainDue(nowMs)`, `drainAll()`, `clear()`, and `bufferedSamples`.

- [ ] **Step 1: Add a failing burst and underrun regression**

Create `scripts/osc-jitter-buffer-regression.ts` with a 1 kHz, two-channel
buffer configured for a 300 ms initial reserve, 100 ms resume reserve, and
50 ms tick. Append ordered samples in bursts, leave a measured-size 200 ms
arrival gap, and assert every pacing tick returns a batch. Append the remaining
samples and assert `drainAll()` makes the complete output sequence equal the
input sequence.

Also exhaust a started buffer, append 99 ms of samples and require no restart,
then append the 100th sample and require immediate restart. The core assertions
are:

```ts
assert.deepEqual([...played, ...tail], samples(0, sourceCount));
assert.equal(resumeBuffer.drainDue(resumeAt), null);
resumeBuffer.appendBatch(batch(1, 99));
assert.ok(resumeBuffer.drainDue(resumeAt + 50));
```

Add this package script:

```json
"test:osc-jitter-buffer": "esbuild scripts/osc-jitter-buffer-regression.ts --bundle --platform=node --format=esm --outfile=node_modules/.tmp/osc-jitter-buffer-regression.mjs && node node_modules/.tmp/osc-jitter-buffer-regression.mjs"
```

- [ ] **Step 2: Run the jitter regression and verify RED**

Run: `npm run test:osc-jitter-buffer`

Expected: build failure because `src/lib/oscJitterBuffer.ts` does not exist.

- [ ] **Step 3: Implement indexed per-channel queues**

Create `src/lib/oscJitterBuffer.ts` with these public options:

```ts
export interface OscJitterBufferOptions {
  channelNos: number[];
  sampleRate: number;
  targetLatencyMs: number;
  resumeLatencyMs: number;
  tickMs: number;
  nowMs?: number;
}
```

Each channel queue stores an array plus a read offset. `take(count)` advances
the offset and compacts only after at least 4,096 consumed values and when the
offset covers at least half the array. Do not use `splice(0, count)` and do not
drop overflow samples.

`drainDue()` arms at `targetLatencyMs` for the first playback and at
`resumeLatencyMs` after an actual empty queue. It converts elapsed time to
sample count, caps catch-up at two ticks, and applies at most a two-percent
occupancy correction:

```ts
const elapsedMs = Math.min(this.tickMs * 2, Math.max(0, now - this.lastDrainAtMs));
const occupancyError = (available - this.targetSamples) / this.targetSamples;
const rateScale = 1 + clamp(occupancyError * 0.05, -0.02, 0.02);
const exactSamples = elapsedMs * this.sampleRate / 1000 * rateScale + this.fractionalSamples;
```

`drainAll()` returns every unread sample in channel order for stop/export and
leaves the queues empty.

- [ ] **Step 4: Run the jitter regression and verify GREEN**

Run: `npm run test:osc-jitter-buffer`

Expected: PASS, with continuous ticks across the 200 ms receive gap, a 100 ms
resume threshold, and exact source/output sample equality.

- [ ] **Step 5: Add the failing cloud-controller integration assertion**

Extend `scripts/osc-fast-start-regression.ts`:

```ts
assert.match(source, /new OscJitterBuffer\(\)/);
assert.match(source, /target\.kind === 'cloud'[\s\S]*?targetLatencyMs: 300/);
assert.match(source, /const cloudTail = cloudJitterBuffer\.drainAll\(\)[\s\S]*?appendSamples\(cloudTail\.batch\)/);
```

- [ ] **Step 6: Run controller regression and verify RED**

Run: `npm run test:osc-fast-start`

Expected: FAIL because the controller has no cloud jitter buffer.

- [ ] **Step 7: Route only cloud address samples through the jitter reserve**

In `useOscController.ts`, keep local samples in `OscRealtimeBuffer`. For cloud
targets, convert each parsed frame to one channel map and append it to
`OscJitterBuffer`. The 50 ms store timer calls `drainDue(performance.now())` for
cloud and `oscBuffer.drain(performance.now())` for local.

Configure cloud reset exactly as:

```ts
cloudJitterBuffer.reset({
  channelNos: channels.map((channel) => channel.channelNo),
  sampleRate: capabilities.sampleRate,
  targetLatencyMs: 300,
  resumeLatencyMs: 100,
  tickMs: STORE_FLUSH_INTERVAL_MS,
  nowMs: performance.now(),
});
```

Stop the timer before draining both possible tails. Append `cloudTail.batch`
and `localTail.batch` before clearing either buffer.

- [ ] **Step 8: Run controller and pipeline regressions**

Run: `npm run test:osc-fast-start`

Expected: PASS.

Run: `npm run test:osc-pipeline-replay`

Expected: all four modes retain 10,002 frames and 300,060 samples.

- [ ] **Step 9: Commit cloud pacing**

```bash
git add package.json scripts/osc-jitter-buffer-regression.ts scripts/osc-fast-start-regression.ts src/lib/oscJitterBuffer.ts src/hooks/useOscController.ts docs/superpowers
git commit -m "perf: pace bursty cloud osc samples"
```

### Task 5: Wait for an Ordered Stop Barrier

**Files:**
- Create: `scripts/osc-stop-barrier-regression.ts`
- Create: `src/lib/oscStopBarrier.ts`
- Modify: `scripts/osc-fast-start-regression.ts`
- Modify: `src/hooks/useOscController.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `FrameRouter.subscribeModbusFrame`, `wsClient.send`, and the CRC
  validated `0x72` matching in `waitForOscResponse`.
- Produces: `waitForOscStopBarrier(options): Promise<'ack' | 'timeout'>`,
  `OscStopBarrierSequence.wait(options)`, and an idempotent asynchronous
  controller stop operation.

- [ ] **Step 1: Add the failing ordered-tail regression**

Start the barrier, feed a valid oscilloscope frame whose header is split after
three magic bytes, and assert finalization has not happened. Then feed the
CRC-valid `buildStopOsc()` ACK and require finalization to observe exactly one
frame. Add a second 10 ms timeout case to prove bounded cleanup.

- [ ] **Step 2: Verify RED**

Run: `npm run test:osc-stop-barrier`

Expected: build failure because `src/lib/oscStopBarrier.ts` does not exist.

- [ ] **Step 3: Implement the strict ACK waiter**

Call `waitForOscResponse` with `request: buildStopOsc()`. Return `ack` when its
function code and CRC match, and `timeout` after any rejected or timed-out
request so cleanup cannot wait forever.

- [ ] **Step 4: Verify the barrier GREEN**

Run: `npm run test:osc-stop-barrier`

Expected: PASS for the late split frame, ACK ordering, and timeout fallback.

- [ ] **Step 5: Integrate an idempotent asynchronous stop**

Keep one module-level `stopPromise`. The first call stops heartbeat traffic and
starts `waitForOscStopBarrier` while waveform parsing and pacing continue.
Repeated calls return the same promise. In `.then()`, set running false, stop
the store timer, append local and cloud tails, and finally clear both buffers,
the waveform handler, and `FrameRouter`.

- [ ] **Step 6: Verify controller lifecycle**

Run: `npm run test:osc-fast-start`

Expected: PASS and source ordering from barrier to timer stop to tail drain.

- [ ] **Step 7: Reproduce a stale cloud-startup ACK**

Extend the barrier regression with two stop operations. Keep the runtime stop
queued behind the preliminary startup stop, feed the startup `0x72` ACK, then a
split final waveform frame, and finally the runtime `0x72` ACK. Assert that only
one stop request is in flight at a time and that the runtime promise does not
resolve on the startup ACK.

- [ ] **Step 8: Sequence identical stop requests and retain timeout debt**

Route cloud fast-start, runtime, local initialization, and start-error stops
through one `OscStopBarrierSequence`. It serializes requests and retains the
number of unconsumed ACKs when a waiter times out. The next waiter accepts only
after those ACKs plus its own response arrive; otherwise it uses the bounded
timeout. Recreate the sequence only when the connection target changes after
the prior waiter has settled.

Bind every queued barrier to the canonical WebSocket target and the
`WsClient.generation` captured for that sequence. Increment the generation on
connect, disconnect, and current-socket close/error. A deferred barrier from an
older generation returns `superseded` without subscribing or sending, while an
already active old-generation barrier ignores all newer-generation ACKs.

- [ ] **Step 9: Verify stale-ACK ordering**

Run: `npm run test:osc-stop-barrier`

Expected: PASS for both `startup ACK -> late split frame -> runtime ACK` and
`startup timeout -> stale startup ACK -> late split frame -> runtime ACK`.

Run: `npm run test:ws-client-generation`

Expected: PASS and prove that connect, target replacement, and disconnect each
advance the monotonic WebSocket generation.

Run: `npm run test:osc-fast-start`

Expected: PASS and source evidence that startup and runtime stop waiters are
sequenced rather than overlapped.

### Task 6: Verify, Deploy, and Synchronize Assets

**Files:**
- Generated locally: `dist/**`
- Synchronize after acceptance: `/mnt/d/Users/sunqi39/Desktop/wireless_debug-main/dist/orig/**`
- Deploy after acceptance: `/home/ubuntu/wireless-debug-cloud/web/orig/**` on `tencent-wireless`

**Interfaces:**
- Consumes: all fixes from Tasks 1-5 and the committed golden fixture.
- Produces: verified production web assets shared by cloud and ESP32.

- [ ] **Step 1: Run all oscilloscope and transport regressions**

Run each command and require exit code 0:

```bash
npm run test:frame-router
npm run test:osc-pipeline-replay
npm run test:osc-stop-barrier
npm run test:osc-real-time-axis
npm run test:osc-realtime-buffer
npm run test:osc-fast-start
npm run test:osc-render-budget
npm run test:osc-request
npm run test:osc-transport
npm run test:modbus-request
npm run test:modbus-osc-sample
npm run test:modbus-osc-cloud-transport
```

- [ ] **Step 2: Run lint and production build**

Run: `npm run lint`

Expected: exit code 0 with no ESLint errors.

Run: `npm run build`

Expected: TypeScript and Vite complete with exit code 0 and produce `dist/a.js`,
`dist/a.css`, compressed assets, and `dist/index.html`.

- [ ] **Step 3: Run browser replay before deployment**

Serve the built app and replay the golden capture through the same 2,048-byte,
20 ms browser fanout used by production. Require exact raw bytes, 10,002 router
frames, 300,060 exported CH1 samples, no timing-created blanks, canvas mean at
most 60 ms, and canvas P95 at most 80 ms.

- [ ] **Step 4: Review the complete source diff**

Run: `git diff b053983..HEAD --check`

Expected: no whitespace errors.

Run: `git diff --stat b053983..HEAD`

Expected: only the files listed in Tasks 1-3 plus these two documents.

- [ ] **Step 5: Deploy cloud static assets**

Back up the current cloud `orig` directory, copy the verified `dist` files to
the cloud deployment, and restart only the web/cloud service required by the
existing deployment. Fetch deployment credentials inside the remote command;
never print `.env` values.

- [ ] **Step 6: Verify the deployed cloud page**

Run the same 30-second browser replay against `wd.claudcode.xyz`. Require the
same frame/sample continuity and rendering thresholds as Step 3, and verify the
parameter table and parameter oscilloscope smoke paths still start and stop.

- [ ] **Step 7: Synchronize ESP32 embedded web assets**

Run: `npm run build:firmware-assets`

Expected: the firmware repo's `dist/orig` matches the verified web `dist` byte
for byte. Do not modify firmware C source.

- [ ] **Step 8: Build firmware and flash once**

Build the ESP-IDF project using its existing workflow. After the user places
the board in download mode, flash the verified firmware once and reset it.

- [ ] **Step 9: Run local-device acceptance**

With the computer connected to the ESP32 AP, run one 30-second `0xC52C` local
capture and compare it to the page export. Verify local and cloud address
oscilloscopes, parameter oscilloscope, parameter table, STA indicator, and page
navigation without device reset.
