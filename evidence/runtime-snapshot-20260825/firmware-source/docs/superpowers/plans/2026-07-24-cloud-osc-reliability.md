# Cloud Oscilloscope Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cloud parameter sampling survive isolated WAN losses and make the cloud address oscilloscope deliver and render the full ESP32 waveform stream without changing verified local behavior.

**Architecture:** The Web client gains cancellable Modbus waits and a three-consecutive-failure cloud policy, while retaining the verified dual-anchor address-frame parser. The ESP32 raw WebSocket uplink sends smoother 2,048-byte messages with a 5,000 ms write timeout and drains brief outages through the existing MQTT fallback. Cloud backend routing and Nginx stay unchanged; only tested static assets are deployed before an app-only flash and end-to-end acceptance.

**Tech Stack:** TypeScript, React, Zustand, Node/esbuild regression scripts, Playwright, ESP-IDF 6.0, ESP32-S3, C/FreeRTOS, `espressif/esp_websocket_client`, Python `websockets`, Flask/Waitress cloud service, MQTT.

## Global Constraints

- Web root: `/mnt/d/Users/sunqi39/Desktop/.codex-osc-continuity-20260723` on branch `fix/cloud-osc-reliability-web-20260724`.
- Firmware/cloud root: `/mnt/d/Users/sunqi39/Desktop/.codex-fw-osc-continuity-20260723` on branch `fix/cloud-osc-reliability-fw-20260724`.
- Preserve CRC-valid header-or-footer address-frame parsing and time-ordered extrema rendering.
- Preserve local AP parameter and address oscilloscope behavior.
- MQTT remains status/discovery/fallback; raw WebSocket remains the normal high-rate path.
- Do not modify Nginx, authentication, credentials, PostgreSQL, or unrelated services.
- Do not flash bootloader, partition table, or SPIFFS storage in this phase.
- Flash only `build/uart_ble_wifi.bin` at `0x10000`, after explicit download-mode confirmation.
- Back up cloud static assets before deployment and archive the new app artifact before flashing.
- Never write cloud credentials into files, command output, commits, or test fixtures.

---

### Task 1: Cancellable Modbus Response Waits

**Repository:** Web

**Files:**
- Modify: `src/lib/modbusRequest.ts`
- Modify: `scripts/modbus-request-regression.ts`

**Interfaces:**
- Consumes: `frameRouter.subscribeModbusFrame(handler)` returning an unsubscribe callback.
- Produces: `waitForMatchingModbusFrame({ timeoutMs, matches, subscribe, signal? }): Promise<Uint8Array>` with `AbortSignal` cancellation and guaranteed unsubscribe.

- [ ] **Step 1: Add the failing abort regression**

Append this case before the final log statement in `scripts/modbus-request-regression.ts`:

```ts
{
  const source = createSource();
  const controller = new AbortController();
  const promise = waitForMatchingModbusFrame({
    timeoutMs: 200,
    subscribe: source.subscribe,
    signal: controller.signal,
  });

  assert.equal(source.handlerCount(), 1, 'active waits must subscribe once');
  controller.abort();
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
  assert.equal(source.handlerCount(), 0, 'aborted waits must unsubscribe immediately');
}
```

- [ ] **Step 2: Run the regression and verify RED**

Run:

```bash
npm run test:modbus-request
```

Expected: TypeScript build fails because `signal` is not a recognized option.

- [ ] **Step 3: Implement abort-aware cleanup**

Add `signal?: AbortSignal` to `WaitForMatchingModbusFrameOptions`. Replace the Promise body with this single-settlement implementation:

```ts
return new Promise((resolve, reject) => {
  let settled = false;
  let unsubscribe = () => {};

  const cleanup = () => {
    clearTimeout(timer);
    unsubscribe();
    signal?.removeEventListener('abort', onAbort);
  };
  const rejectOnce = (error: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(error);
  };
  const onAbort = () => rejectOnce(new DOMException('Modbus wait aborted', 'AbortError'));
  const timer = setTimeout(() => {
    rejectOnce(new Error(`modbus timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  unsubscribe = subscribe((frame) => {
    if (settled || !matches(frame)) return;
    settled = true;
    cleanup();
    resolve(frame);
  });

  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
});
```

- [ ] **Step 4: Verify GREEN and neighboring request behavior**

Run:

```bash
npm run test:modbus-request
npm run test:param-batch-read
```

Expected: both commands exit 0; resolved, timed-out, and aborted waits all leave zero subscribers.

- [ ] **Step 5: Commit the request primitive**

```bash
git add src/lib/modbusRequest.ts scripts/modbus-request-regression.ts
git commit -m "fix: make modbus waits cancellable"
```

---

### Task 2: Three-Failure Cloud Sampling Policy

**Repository:** Web

**Files:**
- Modify: `src/lib/modbusOscTransportPolicy.ts`
- Modify: `scripts/modbus-osc-cloud-transport-regression.ts`

**Interfaces:**
- Consumes: connection kinds `local`, `cloud`, and `invalid` from `ConnectionTarget`.
- Produces: `CLOUD_MODBUS_OSC_MAX_CONSECUTIVE_FAILURES = 3` and `modbusOscCycleAction(kind, hasError, consecutiveFailures)` returning `append`, `continue`, or `stop`.

- [ ] **Step 1: Replace the single-failure assertions with failure-budget assertions**

Update the imports and policy checks in `scripts/modbus-osc-cloud-transport-regression.ts` to:

```ts
import {
  CLOUD_MODBUS_OSC_MAX_CONSECUTIVE_FAILURES,
  modbusOscCycleAction,
  modbusOscResponseTimeoutMs,
} from '../src/lib/modbusOscTransportPolicy';

assert.equal(CLOUD_MODBUS_OSC_MAX_CONSECUTIVE_FAILURES, 3);
assert.equal(modbusOscResponseTimeoutMs('local'), 1000);
assert.equal(modbusOscResponseTimeoutMs('cloud'), 2800);
assert.equal(modbusOscCycleAction('cloud', false, 0), 'append');
assert.equal(modbusOscCycleAction('cloud', true, 1), 'continue');
assert.equal(modbusOscCycleAction('cloud', true, 2), 'continue');
assert.equal(modbusOscCycleAction('cloud', true, 3), 'stop');
assert.equal(modbusOscCycleAction('local', true, 1), 'append');
```

Remove the existing controller source checks from this pure-policy regression;
Task 3 adds the new integration contracts after the policy API is green.

- [ ] **Step 2: Run the policy regression and verify RED**

Run:

```bash
npm run test:modbus-osc-cloud-transport
```

Expected: compile or assertion failure because the current API has no failure count and stops on the first cloud failure.

- [ ] **Step 3: Implement the pure policy**

Replace `src/lib/modbusOscTransportPolicy.ts` with:

```ts
import type { ConnectionTarget } from './connectionTarget';

type ConnectionKind = ConnectionTarget['kind'];
export type ModbusOscCycleAction = 'append' | 'continue' | 'stop';
export const CLOUD_MODBUS_OSC_MAX_CONSECUTIVE_FAILURES = 3;

export function modbusOscResponseTimeoutMs(kind: ConnectionKind): number {
  return kind === 'cloud' ? 2800 : 1000;
}

export function modbusOscCycleAction(
  kind: ConnectionKind,
  hasError: boolean,
  consecutiveFailures: number,
): ModbusOscCycleAction {
  if (!hasError) return 'append';
  if (kind !== 'cloud') return 'append';
  return consecutiveFailures >= CLOUD_MODBUS_OSC_MAX_CONSECUTIVE_FAILURES
    ? 'stop'
    : 'continue';
}
```

- [ ] **Step 4: Verify the pure policy passes**

Run:

```bash
npm run test:modbus-osc-cloud-transport
```

Expected: all policy assertions pass and the command exits 0.

- [ ] **Step 5: Commit the green policy**

```bash
git add src/lib/modbusOscTransportPolicy.ts scripts/modbus-osc-cloud-transport-regression.ts
git commit -m "fix: budget transient cloud osc failures"
```

---

### Task 3: Parameter Controller Cancellation and Disconnect Cleanup

**Repository:** Web

**Files:**
- Modify: `src/hooks/useModbusOscController.ts`
- Modify: `src/components/ModbusOscPage.tsx`
- Modify: `scripts/modbus-osc-cloud-transport-regression.ts`

**Interfaces:**
- Consumes: cancellable `waitForMatchingModbusFrame` from Task 1 and failure policy from Task 2.
- Produces: one `AbortController` and one consecutive-failure counter per active module-level sampling run; `stop()` aborts the waiter and clears polling.

- [ ] **Step 1: Add failing controller source contracts**

Add assertions that require all of these patterns:

```ts
assert.match(controller, /waitForMatchingModbusFrame/);
assert.match(controller, /let modbusOscAbortController: AbortController \| null = null/);
assert.match(controller, /let modbusOscConsecutiveFailures = 0/);
assert.match(controller, /cycleError \? modbusOscConsecutiveFailures \+ 1 : 0/);
assert.match(controller, /modbusOscCycleAction\([\s\S]*modbusOscConsecutiveFailures/);
assert.match(controller, /if \(cycleAction === 'append'\)[\s\S]*pushSamples/);
assert.match(controller, /modbusOscAbortController\?\.abort\(\)/);

const pageSource = readFileSync('src/components/ModbusOscPage.tsx', 'utf8');
assert.match(
  pageSource,
  /useEffect\(\(\) => \{[\s\S]*if \(!connected && running\) stop\(\)/,
  'connection loss must stop parameter polling immediately',
);
```

- [ ] **Step 2: Run the regression and verify RED**

Run:

```bash
npm run test:modbus-osc-cloud-transport
```

Expected: failure because the controller still owns a singleton handler, has no abort controller, and stops after one cloud error.

- [ ] **Step 3: Replace the private waiter with the shared cancellable waiter**

Import `waitForMatchingModbusFrame` and implement:

```ts
function waitModbusFrame(
  timeoutMs: number,
  expectedRegisterCount: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  return waitForMatchingModbusFrame({
    timeoutMs,
    signal,
    matches: (frame) => (
      parseReadResponse(frame, expectedRegisterCount, { allowBadCrc: true }) != null
    ),
  });
}

let modbusOscTimer: ReturnType<typeof setInterval> | null = null;
let modbusOscBusy = false;
let modbusOscAbortController: AbortController | null = null;
let modbusOscConsecutiveFailures = 0;
```

At start, abort the previous run, create a new controller, reset the failure count, and capture `const signal = modbusOscAbortController.signal`. Pass that signal to every `waitModbusFrame` call.

- [ ] **Step 4: Apply failure accounting without fake cloud samples**

In `pollOnce`, ignore abort errors from a stopped run. In `finally`, return after clearing `modbusOscBusy` when `signal.aborted`. Otherwise use:

```ts
modbusOscConsecutiveFailures = cycleError
  ? modbusOscConsecutiveFailures + 1
  : 0;
const cycleAction = modbusOscCycleAction(
  target.kind,
  cycleError !== null,
  modbusOscConsecutiveFailures,
);
if (cycleAction === 'append') {
  const completedSamples = completeOscSample(
    pageParams.map((param) => param.alias),
    samples,
  );
  pushSamples(completedSamples);
  recordIoSamples(pageParams.length);
}
```

`continue` performs no append and leaves the timer running. `stop` clears the timer, aborts the waiter, and sets running false.

- [ ] **Step 5: Make manual stop and connection loss cancel immediately**

At the start of `stop()`:

```ts
modbusOscAbortController?.abort();
modbusOscAbortController = null;
modbusOscConsecutiveFailures = 0;
```

Add this effect after `const { start, stop } = useModbusOscController();` in `ModbusOscPage.tsx`:

```ts
useEffect(() => {
  if (!connected && running) stop();
}, [connected, running, stop]);
```

- [ ] **Step 6: Verify controller behavior and no regressions**

Run:

```bash
npm run test:modbus-request
npm run test:modbus-osc-cloud-transport
npm run test:modbus-osc-sample
npm run test:frame-router
```

Expected: all commands exit 0. Cloud failed cycles do not append; local failed cycles retain their prior append behavior.

- [ ] **Step 7: Commit controller integration**

```bash
git add src/hooks/useModbusOscController.ts src/components/ModbusOscPage.tsx src/lib/modbusOscTransportPolicy.ts scripts/modbus-osc-cloud-transport-regression.ts
git commit -m "fix: recover cloud parameter sampling"
```

---

### Task 4: Web Build, Full Regression, and Firmware Asset Sync

**Repositories:** Web, then Firmware/cloud

**Files:**
- Generated in Web: `dist/a.js`, `dist/a.js.gz`, `dist/a.css`, `dist/a.css.gz`, `dist/x.js`, `dist/x.js.gz`, `dist/index.html`, `dist/index.html.gz`
- Update in Firmware/cloud: `dist/orig/a.js`, `dist/orig/a.js.gz`, `dist/orig/a.css`, `dist/orig/a.css.gz`, `dist/orig/x.js`, `dist/orig/x.js.gz`, `dist/orig/i.html`, `dist/orig/i.html.gz`

**Interfaces:**
- Consumes: Web behavior completed in Tasks 1-3 and existing frame fidelity commits.
- Produces: one hash-identical cloud/firmware asset tree ready for deployment.

- [ ] **Step 1: Run the focused and full Web checks**

From the Web root:

```bash
npm run test:modbus-request
npm run test:modbus-osc-cloud-transport
npm run test:frame-router
npm run test:osc-history-render-order
npm run test:osc-pipeline-replay
npm run test:unified-smoke
npm run lint
```

Expected: every test and production build exits 0; ESLint reports zero errors. Existing warnings may remain unchanged.

- [ ] **Step 2: Copy the exact tested outputs into the firmware worktree**

Run these commands from the firmware/cloud root:

```bash
install -m 0644 ../.codex-osc-continuity-20260723/dist/a.js dist/orig/a.js
install -m 0644 ../.codex-osc-continuity-20260723/dist/a.js.gz dist/orig/a.js.gz
install -m 0644 ../.codex-osc-continuity-20260723/dist/a.css dist/orig/a.css
install -m 0644 ../.codex-osc-continuity-20260723/dist/a.css.gz dist/orig/a.css.gz
install -m 0644 ../.codex-osc-continuity-20260723/dist/x.js dist/orig/x.js
install -m 0644 ../.codex-osc-continuity-20260723/dist/x.js.gz dist/orig/x.js.gz
install -m 0644 ../.codex-osc-continuity-20260723/dist/index.html dist/orig/i.html
install -m 0644 ../.codex-osc-continuity-20260723/dist/index.html.gz dist/orig/i.html.gz
```

- [ ] **Step 3: Verify byte identity**

Run:

```bash
cmp ../.codex-osc-continuity-20260723/dist/a.js dist/orig/a.js
cmp ../.codex-osc-continuity-20260723/dist/a.js.gz dist/orig/a.js.gz
sha256sum ../.codex-osc-continuity-20260723/dist/a.js dist/orig/a.js
sha256sum ../.codex-osc-continuity-20260723/dist/a.js.gz dist/orig/a.js.gz
```

Expected: both `cmp` commands exit 0 and each source/destination hash pair is identical.

- [ ] **Step 4: Commit embedded assets in the firmware repository**

```bash
git add dist/orig
git commit -m "chore: embed cloud osc reliability assets"
```

---

### Task 5: ESP32 Uplink Smoothing and MQTT Fallback

**Repository:** Firmware/cloud

**Files:**
- Modify: `scripts/cloud_osc_transport_regression.mjs`
- Modify: `main/cloud_ws_uplink.c`
- Modify: `main/main.c`

**Interfaces:**
- Consumes: `cloud_ws_uplink_config_t.fallback`, `cloud_mqtt_publish_ws_fallback(data, len, ctx)`, and existing uplink telemetry fields.
- Produces: 2,048-byte raw batches, 5,000 ms network/write timeout, and exactly-once raw-or-fallback source-frame accounting.

- [ ] **Step 1: Rewrite the old no-fallback contracts as reliability contracts**

In `scripts/cloud_osc_transport_regression.mjs`, require:

```js
assert.match(uplink, /#define CLOUD_WS_UPLINK_SEND_TIMEOUT_MS 5000/);
assert.ok(uplink.includes('#define CLOUD_WS_UPLINK_SEND_FRAME_MAX 2048U'));
assert.match(
  mainSource,
  /\.fallback = cloud_mqtt_publish_ws_fallback[\s\S]*\.fallback_ctx = NULL/,
);
assert.match(
  senderTaskBody,
  /if \(!s_connected \|\| s_client == NULL\)[\s\S]*fallback_frame\(frame\)/,
);
assert.match(
  senderTaskBody,
  /sent != \(int\)frame->len[\s\S]*send_failures[\s\S]*fallback_frame\(frame\)/,
);
assert.match(
  uplink,
  /fallback_frame[\s\S]*queued_fallback_frames/,
);
```

Remove assertions that require `1000`, `8192`, `.fallback = NULL`, queue preservation while disconnected, and unconditional overload-drop accounting on every failed send.

- [ ] **Step 2: Run the firmware transport regression and verify RED**

Run:

```bash
node scripts/cloud_osc_transport_regression.mjs
```

Expected: assertion failure showing the current 8,192-byte/1,000 ms/no-fallback implementation.

- [ ] **Step 3: Add one bounded fallback helper**

Add before `sender_task` in `main/cloud_ws_uplink.c`:

```c
static bool fallback_frame(const cloud_ws_uplink_send_frame_t *frame)
{
    if (frame == NULL || frame->len == 0 || s_config.fallback == NULL) {
        return false;
    }

    bool complete = true;
    size_t offset = 0;
    while (offset < frame->len) {
        size_t chunk_len = frame->len - offset;
        if (chunk_len > CLOUD_WS_UPLINK_MAX_FRAME) {
            chunk_len = CLOUD_WS_UPLINK_MAX_FRAME;
        }
        if (!s_config.fallback(frame->data + offset, chunk_len, s_config.fallback_ctx)) {
            complete = false;
        }
        offset += chunk_len;
    }
    if (complete) {
        stats_increment(&s_stats.queued_fallback_frames, frame->source_frames);
    }
    return complete;
}
```

- [ ] **Step 4: Smooth normal sends and handle disconnected frames**

Change constants to:

```c
#define CLOUD_WS_UPLINK_SEND_FRAME_MAX 2048U
#define CLOUD_WS_UPLINK_SEND_TIMEOUT_MS 5000
```

Remove the pre-dequeue disconnected wait. After aggregation and before raw send, use:

```c
if (!s_connected || s_client == NULL) {
    if (!fallback_frame(frame)) {
        stats_increment(&s_stats.overload_dropped_frames, frame->source_frames);
    }
    continue;
}
```

For a short or failed `esp_websocket_client_send_bin` result, increment `send_failures`, call `fallback_frame(frame)`, and increment `overload_dropped_frames` only when fallback is not complete. Keep successful raw counters unchanged.

- [ ] **Step 5: Wire the existing MQTT fallback callback**

In `main/main.c`, set:

```c
.fallback = cloud_mqtt_publish_ws_fallback,
.fallback_ctx = NULL,
```

Do not change the downlink callback or lease ordering.

- [ ] **Step 6: Verify GREEN across firmware and cloud relay contracts**

Run:

```bash
node scripts/cloud_osc_transport_regression.mjs
node scripts/cloud_mqtt_contract_regression.mjs
node scripts/remote_mqtt_python_regression.mjs
python3 scripts/cloud_ws_downlink_regression.py
cc -std=c11 -Wall -Wextra -Werror scripts/cloud_ws_downlink_reassembly_regression.c -o /tmp/cloud_ws_downlink_reassembly_regression
/tmp/cloud_ws_downlink_reassembly_regression
cc -std=c11 -Wall -Wextra -Werror scripts/cloud_ws_lease_regression.c -o /tmp/cloud_ws_lease_regression
/tmp/cloud_ws_lease_regression
```

Expected: all seven commands exit 0.

- [ ] **Step 7: Commit the firmware behavior**

```bash
git add main/cloud_ws_uplink.c main/main.c scripts/cloud_osc_transport_regression.mjs
git commit -m "fix: stabilize cloud osc uplink"
```

---

### Task 6: ESP-IDF Build and New Artifact Archive

**Repository:** Firmware/cloud

**Files:**
- Generated: `build/uart_ble_wifi.bin`
- Archive: `/mnt/d/Users/sunqi39/Desktop/archives/cloud-osc-reliability-20260724/`

**Interfaces:**
- Consumes: committed firmware and embedded Web assets from Tasks 4-5.
- Produces: verified app binary and a pre-flash recovery package.

- [ ] **Step 1: Build with the verified Windows ESP-IDF 6.0 environment**

Run from WSL:

```text
cmd.exe /C "cd /D D:\Users\sunqi39\Desktop\.codex-fw-osc-continuity-20260723 && C:\esp\v6.0\esp-idf\export.bat >nul 2>nul && idf.py build"
```

Expected: `Project build complete.` and a successful app partition size check.

- [ ] **Step 2: Record build identity and flash metadata**

Run:

```bash
stat -c '%s %y %n' build/uart_ble_wifi.bin
sha256sum build/uart_ble_wifi.bin build/bootloader/bootloader.bin build/partition_table/partition-table.bin build/storage.bin
sed -n '1,180p' build/flasher_args.json
```

Expected: app size is below the `0x280000` app partition and `flasher_args.json` still maps app to `0x10000`.

- [ ] **Step 3: Create the new immutable recovery directory**

Run:

```bash
mkdir -p /mnt/d/Users/sunqi39/Desktop/archives/cloud-osc-reliability-20260724/app /mnt/d/Users/sunqi39/Desktop/archives/cloud-osc-reliability-20260724/web
install -m 0644 build/uart_ble_wifi.bin build/flasher_args.json build/flash_args partitions.csv sdkconfig /mnt/d/Users/sunqi39/Desktop/archives/cloud-osc-reliability-20260724/app/
cp -a dist/orig/. /mnt/d/Users/sunqi39/Desktop/archives/cloud-osc-reliability-20260724/web/
```

- [ ] **Step 4: Generate and verify archive checksums**

Run from the archive directory:

```bash
find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
sha256sum -c SHA256SUMS
```

Expected: every file reports `OK`.

---

### Task 7: Back Up and Deploy Cloud Static Assets

**Repository:** Firmware/cloud locally; `/home/ubuntu/wireless-debug-cloud` remotely

**Files:**
- Backup remote: `/home/ubuntu/wireless-debug-cloud/backups/orig-before-cloud-osc-reliability-20260724`
- Deploy remote: `/home/ubuntu/wireless-debug-cloud/dist/orig/`

**Interfaces:**
- Consumes: hash-verified `dist/orig/` from Task 4.
- Produces: cloud page serving the same tested JavaScript; no service or Nginx change.

- [ ] **Step 1: Capture pre-deployment state**

```bash
ssh -o BatchMode=yes tencent-wireless 'set -e
cd /home/ubuntu/wireless-debug-cloud
sha256sum dist/orig/a.js dist/orig/a.js.gz
test ! -e backups/orig-before-cloud-osc-reliability-20260724
mkdir -p backups
cp -a dist/orig backups/orig-before-cloud-osc-reliability-20260724
'
```

Expected: backup directory is created once and the old deployed hash is recorded.

- [ ] **Step 2: Stage assets without touching unrelated server files**

```bash
ssh -o BatchMode=yes tencent-wireless 'rm -rf /tmp/wd-cloud-osc-orig-20260724 && mkdir -p /tmp/wd-cloud-osc-orig-20260724'
tar -C dist/orig -cf - . | ssh -o BatchMode=yes tencent-wireless 'tar -C /tmp/wd-cloud-osc-orig-20260724 -xf -'
```

- [ ] **Step 3: Atomically replace only the static asset directory**

```bash
ssh -o BatchMode=yes tencent-wireless 'set -e
cd /home/ubuntu/wireless-debug-cloud
rm -rf dist/orig.next
mv /tmp/wd-cloud-osc-orig-20260724 dist/orig.next
rm -rf dist/orig
mv dist/orig.next dist/orig
'
```

Do not restart Nginx or Docker for this static-only deployment.

- [ ] **Step 4: Verify remote/local hashes and HTTP delivery**

```bash
sha256sum dist/orig/a.js dist/orig/a.js.gz
ssh -o BatchMode=yes tencent-wireless 'cd /home/ubuntu/wireless-debug-cloud && sha256sum dist/orig/a.js dist/orig/a.js.gz'
curl -fsS --compressed --max-time 30 https://wd.claudcode.xyz/remote/wd-ac276eab7c9c/orig/a.js -u "$CLOUD_HTTP_USER:$CLOUD_HTTP_PASSWORD" | sha256sum
```

Expected: remote filesystem and HTTP uncompressed `a.js` hashes match the local uncompressed build.

---

### Task 8: App-Only Flash

**Repository:** Firmware/cloud build output

**Files:**
- Flash input: `build/uart_ble_wifi.bin`
- Offset: `0x10000`

**Interfaces:**
- Consumes: archived, hash-verified app image from Task 6.
- Produces: device running the new uplink code while retaining existing bootloader, partition table, and SPIFFS.

- [ ] **Step 1: Wait for explicit download-mode confirmation**

Do not issue an esptool write command until the user confirms the device is in download mode and the physical cable is secure.

- [ ] **Step 2: Confirm the active FTDI serial port and chip**

```text
D:\Users\sunqi39\.espressif\python_env\idf6.0_py3.11_env\Scripts\python.exe -c "import serial.tools.list_ports as p; print('\n'.join(f'{x.device}\t{x.description}\t{x.hwid}' for x in p.comports()))"
D:\Users\sunqi39\.espressif\python_env\idf6.0_py3.11_env\Scripts\python.exe -m esptool --chip esp32s3 -p COM4 -b 115200 chip-id
```

Expected: COM4 is the FTDI `0403:6001` port and esptool identifies ESP32-S3. If COM4 differs, use the detected FTDI port.

- [ ] **Step 3: Flash only the app partition**

```text
D:\Users\sunqi39\.espressif\python_env\idf6.0_py3.11_env\Scripts\python.exe -m esptool --chip esp32s3 -p COM4 -b 460800 --before default-reset --after hard-reset write-flash --flash-mode dio --flash-freq 80m --flash-size 8MB 0x10000 D:\Users\sunqi39\Desktop\.codex-fw-osc-continuity-20260723\build\uart_ble_wifi.bin
```

Expected: `Hash of data verified.` and hard reset. No other offset appears in the command.

- [ ] **Step 4: Return the board to normal boot**

Remove the download jumper, reset the board, wait for STA/cloud reconnect, and verify a fresh device status reports `cloud_ws_uplink.schema_version >= 5` and `connected: true`.

---

### Task 9: Protocol, Fault-Injection, Local Regression, and Playwright Acceptance

**Repositories:** Web and Firmware/cloud

**Files:**
- Existing: `scripts/cloud-modbus-continuity.py`
- Existing: `scripts/cloud_osc_hardware_acceptance.py`
- Create in Web: `scripts/cloud-osc-ui-acceptance.mjs`
- Evidence output: `/tmp/cloud-param-5min.json`, `/tmp/cloud-address-60s.json`, `/tmp/cloud-address-fallback.json`, `/tmp/cloud-osc-playwright.png`

**Interfaces:**
- Consumes: deployed cloud assets and flashed app.
- Produces: protocol metrics, telemetry deltas, fallback evidence, and browser screenshot.

- [ ] **Step 1: Run five minutes of parameter protocol continuity from the cloud host**

```bash
ssh -o BatchMode=yes tencent-wireless 'cd /home/ubuntu/wireless-debug-cloud/tools/remote_mqtt_python; sudo docker compose exec -T -e CLOUD_WS_URL=ws://127.0.0.1:18089/ws/device/wd-ac276eab7c9c -e CYCLES=600 -e INTERVAL_MS=500 -e TIMEOUT_MS=2800 cloud python -' < /mnt/d/Users/sunqi39/Desktop/.codex-osc-continuity-20260723/scripts/cloud-modbus-continuity.py
```

Expected: 600 requests, 600 responses, zero terminal timeout. If an isolated response is lost, retain the raw result as evidence and continue to the Playwright policy check; do not misreport it as a pass.

- [ ] **Step 2: Run a 60-second normal address stream**

Run the acceptance script inside the cloud container so localhost bypasses desktop proxy behavior:

```bash
ssh -o BatchMode=yes tencent-wireless 'cd /home/ubuntu/wireless-debug-cloud/tools/remote_mqtt_python; sudo docker compose exec -T cloud python - --mode cloud --device-id wd-ac276eab7c9c --duration 60 --no-inject-fallback --min-bytes-per-second 60000 --max-p95-ms 100 --max-gap-ms 750 --cloud-http http://127.0.0.1:18088 --cloud-ws ws://127.0.0.1:18089' < scripts/cloud_osc_hardware_acceptance.py
```

Expected: verdict passes, at least 60 KB/s, P95 at most 100 ms, maximum gap at most 750 ms, and zero deltas for uplink send failures, queue full, and overload drops.

- [ ] **Step 3: Run duplicate-uplink fault injection**

```bash
ssh -o BatchMode=yes tencent-wireless 'cd /home/ubuntu/wireless-debug-cloud/tools/remote_mqtt_python; sudo docker compose exec -T cloud python - --mode cloud --device-id wd-ac276eab7c9c --duration 20 --inject-fallback --min-bytes-per-second 15000 --max-p95-ms 100 --max-gap-ms 750 --cloud-http http://127.0.0.1:18088 --cloud-ws ws://127.0.0.1:18089' < scripts/cloud_osc_hardware_acceptance.py
```

Expected: fallback injection completes, `fallback_frames` and browser fallback-window frames increase, fallback failures remain zero, and raw uplink reconnects.

- [ ] **Step 4: Re-run verified local address continuity**

After reconnecting the PC to the ESP AP:

```bash
scripts/run_cloud_osc_hardware_acceptance.sh --mode local --duration 20 --min-bytes-per-second 15000 --max-p95-ms 50 --max-gap-ms 750 --output /tmp/cloud-osc-local-regression.json
```

Expected: local verdict passes with zero UART overflow, Wi-Fi pool exhaustion, Wi-Fi queue full, and route partial-drop deltas.

- [ ] **Step 5: Create the authenticated sustained Playwright acceptance script**

Create `scripts/cloud-osc-ui-acceptance.mjs` in the Web repository:

```js
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { strict as assert } from 'node:assert';

const runner = process.env.WIRELESS_DEBUG_PW_RUNNER || '/tmp/wireless_debug_playwright_runner';
const requireFromRunner = createRequire(`${runner}/runner.js`);
const { chromium } = requireFromRunner('playwright');
const url = process.env.CLOUD_REMOTE_URL ||
  'https://wd.claudcode.xyz/remote/wd-ac276eab7c9c/orig/i.html';
const paramTable = process.env.PARAM_TABLE ||
  '/mnt/d/Users/sunqi39/Downloads/ParameterTable.xlsx';
const username = process.env.CLOUD_HTTP_USER || '';
const password = process.env.CLOUD_HTTP_PASSWORD || '';

assert.ok(username && password, 'cloud credentials must be supplied through the environment');
assert.ok(existsSync(paramTable), `parameter table missing: ${paramTable}`);

function parseParamStatus(text) {
  const io = text.match(/请求\/响应:\s*(\d+)\/(\d+)/);
  const samples = text.match(/样本:\s*(\d+)/);
  return {
    requests: Number(io?.[1] || 0),
    responses: Number(io?.[2] || 0),
    samples: Number(samples?.[1] || 0),
    running: /状态:\s*运行中/.test(text),
  };
}

const authorization = Buffer.from(`${username}:${password}`).toString('base64');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  extraHTTPHeaders: { Authorization: `Basic ${authorization}` },
  viewport: { width: 1600, height: 900 },
});
const page = await context.newPage();
let wsRxBytes = 0;

page.on('websocket', (socket) => {
  if (!socket.url().includes('/ws/device/')) return;
  socket.on('framereceived', (payload) => {
    const value = payload && typeof payload === 'object' && 'payload' in payload
      ? payload.payload
      : payload;
    if (typeof value === 'string') wsRxBytes += Buffer.byteLength(value, 'binary');
    else if (Buffer.isBuffer(value)) wsRxBytes += value.length;
    else if (value instanceof ArrayBuffer) wsRxBytes += value.byteLength;
    else if (ArrayBuffer.isView(value)) wsRxBytes += value.byteLength;
  });
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(6000);
await page.locator('input[type=file]').first().setInputFiles(paramTable);
await page.waitForTimeout(2500);

await page.getByRole('button', { name: /参数示波器/ }).first().click();
await page.waitForTimeout(800);
await page.locator('select').first().selectOption({ label: 'MOTOR0' });
await page.locator('input[type=number]').first().fill('500');
await page.getByRole('button', { name: /开始/ }).first().click();

const paramDeadline = Date.now() + 300000;
let paramStatus = parseParamStatus(await page.locator('body').innerText());
while (Date.now() < paramDeadline) {
  await page.waitForTimeout(1000);
  paramStatus = parseParamStatus(await page.locator('body').innerText());
  assert.equal(paramStatus.running, true, 'parameter oscilloscope stopped during five-minute soak');
}
assert.ok(paramStatus.requests > 0, 'parameter soak sent no requests');
assert.ok(paramStatus.responses > 0, 'parameter soak received no responses');
assert.ok(paramStatus.samples > 0, 'parameter soak appended no samples');
await page.getByRole('button', { name: /停止/ }).first().click();

await page.getByRole('button', { name: /地址示波器/ }).first().click();
await page.waitForTimeout(800);
await page.locator('select').first().selectOption('4');
const textInputs = page.locator('input[type=text]');
for (const [index, value] of ['C52C', 'CH1', '0000', 'CH2', '0000', 'CH3', '0000', 'CH4'].entries()) {
  await textInputs.nth(index).fill(value);
}
const addressRxStart = wsRxBytes;
await page.getByRole('button', { name: /开始/ }).first().click();
await page.waitForTimeout(60000);

const addressText = await page.locator('body').innerText();
assert.match(addressText, /状态:\s*运行中/, 'address oscilloscope did not remain running');
const cache = addressText.match(/缓存:\s*([0-9.]+)s\s*\/\s*([0-9.]+)\s*MB/);
assert.ok(cache, 'address cache metrics missing');
assert.ok(Number(cache[1]) >= 30, `address cache too short: ${cache[1]}s`);
assert.ok(Number(cache[2]) > 0, 'address cache bytes stayed at zero');
assert.ok(wsRxBytes - addressRxStart >= 2000000, 'address websocket delivered under 2 MB');
await page.screenshot({ path: '/tmp/cloud-osc-playwright.png', fullPage: true });
await page.getByRole('button', { name: /停止/ }).first().click();

console.log(JSON.stringify({ paramStatus, addressRxBytes: wsRxBytes - addressRxStart }));
await browser.close();
```

- [ ] **Step 6: Run the sustained cloud UI acceptance**

Load credentials into environment variables without printing them, then run:

```bash
WIRELESS_DEBUG_PW_RUNNER=/tmp/wireless_debug_playwright_runner \
CLOUD_REMOTE_URL="https://wd.claudcode.xyz/remote/wd-ac276eab7c9c/orig/i.html" \
PARAM_TABLE="/mnt/d/Users/sunqi39/Downloads/ParameterTable.xlsx" \
CLOUD_HTTP_USER="$CLOUD_HTTP_USER" \
CLOUD_HTTP_PASSWORD="$CLOUD_HTTP_PASSWORD" \
node scripts/cloud-osc-ui-acceptance.mjs
```

Expected: five-minute parameter soak stays running, address cache exceeds 30 seconds and 2 MB, WebSocket receive bytes exceed 2 MB, and `/tmp/cloud-osc-playwright.png` shows nonblank charts without the doubled wrap edge.

- [ ] **Step 7: Commit the reusable acceptance script**

```bash
git add scripts/cloud-osc-ui-acceptance.mjs
git commit -m "test: add cloud osc UI acceptance"
```

- [ ] **Step 8: Final verification and status capture**

Run the Web tests from Task 4, firmware regressions from Task 5, and capture:

```bash
git -C /mnt/d/Users/sunqi39/Desktop/.codex-osc-continuity-20260723 status --short
git -C /mnt/d/Users/sunqi39/Desktop/.codex-fw-osc-continuity-20260723 status --short
sha256sum /mnt/d/Users/sunqi39/Desktop/.codex-fw-osc-continuity-20260723/build/uart_ble_wifi.bin
```

Expected: both worktrees are clean, all automated tests pass, deployed asset hash matches the tested build, and the app hash matches the recovery archive.

## Rollback

If cloud static verification fails, restore without restarting Nginx:

```bash
ssh -o BatchMode=yes tencent-wireless 'set -e
cd /home/ubuntu/wireless-debug-cloud
rm -rf dist/orig
cp -a backups/orig-before-cloud-osc-reliability-20260724 dist/orig
'
```

If app acceptance fails, enter download mode and flash only the archived app:

```text
D:\Users\sunqi39\.espressif\python_env\idf6.0_py3.11_env\Scripts\python.exe -m esptool --chip esp32s3 -p COM4 -b 460800 --before default-reset --after hard-reset write-flash --flash-mode dio --flash-freq 80m --flash-size 8MB 0x10000 D:\Users\sunqi39\Desktop\archives\osc-continuity-20260724-153621\flash-artifacts\uart_ble_wifi.bin
```

The archived bootloader, partition table, and `storage.bin` remain untouched.
