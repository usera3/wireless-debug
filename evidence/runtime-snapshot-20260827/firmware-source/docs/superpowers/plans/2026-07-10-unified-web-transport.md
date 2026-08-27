# Unified Web Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one React web build work both on ESP32 LAN and on the cloud console through runtime-selected communication adapters.

**Architecture:** Keep one UI bundle. Detect local vs cloud mode from runtime globals injected by the host, then route HTTP APIs and WebSocket frames through a small frontend transport layer. On the cloud side, add a real browser-to-cloud WebSocket endpoint and bridge frames to ESP32 over MQTT.

**Tech Stack:** React/Vite/TypeScript frontend, Flask/Python cloud console, `websockets` Python package for the cloud WebSocket endpoint, MQTT for cloud-to-device transport.

## Global Constraints

- ESP32 local mode keeps native `ws://192.168.4.1/ws` behavior.
- Cloud mode must not require browser access to `192.168.4.1`.
- Cloud mode must show a cloud tunnel address instead of a local ESP32 WebSocket address.
- Cloud WiFi mode switching remains blocked by the backend.
- Existing `/remote/<device_id>/api/*` and Excel proxy endpoints stay compatible.
- Static assets must be copied from `/mnt/d/Users/sunqi39/Desktop/wireless_debug_web/dist` to `/mnt/d/Users/sunqi39/Desktop/wireless_debug-main/dist/orig`.

---

### Task 1: Runtime Transport Config

**Files:**
- Create: `/mnt/d/Users/sunqi39/Desktop/wireless_debug_web/src/lib/remoteConsole.ts`
- Modify: `/mnt/d/Users/sunqi39/Desktop/wireless_debug_web/src/store/connectionStore.ts`
- Modify: `/mnt/d/Users/sunqi39/Desktop/wireless_debug_web/src/components/ConnectionPanel.tsx`
- Test: `/mnt/d/Users/sunqi39/Desktop/wireless_debug_web/scripts/connection-panel-copy-regression.ts`

**Interfaces:**
- Produces: `remoteConsoleDeviceId(): string | null`
- Produces: `remoteConsoleWsUrl(): string | null`
- Produces: `isRemoteConsole(): boolean`
- Consumes: `window.__WIRELESS_REMOTE_DEVICE_ID`
- Consumes: `window.__WIRELESS_REMOTE_WS_URL`

- [ ] **Step 1: Write the failing test**

Add assertions that the connection panel contains cloud tunnel wording and does not force the cloud page to display the ESP32 LAN WebSocket address as the active connection.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:connection-panel`
Expected: FAIL until the cloud tunnel copy and helper usage exist.

- [ ] **Step 3: Implement runtime helpers**

Create `remoteConsole.ts` and use it from `connectionStore.ts` and `ConnectionPanel.tsx`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:connection-panel`
Expected: PASS.

### Task 2: Cloud WebSocket Bridge

**Files:**
- Modify: `/mnt/d/Users/sunqi39/Desktop/wireless_debug-main/tools/remote_mqtt_python/app.py`
- Modify: `/mnt/d/Users/sunqi39/Desktop/wireless_debug-main/tools/remote_mqtt_python/requirements.txt`
- Modify: `/mnt/d/Users/sunqi39/Desktop/wireless_debug-main/tools/remote_mqtt_python/Dockerfile`
- Modify: `/mnt/d/Users/sunqi39/Desktop/wireless_debug-main/tools/remote_mqtt_python/docker-compose.yml`
- Modify: `/mnt/d/Users/sunqi39/Desktop/wireless_debug-main/tools/remote_mqtt_python/.env.example`
- Test: `/mnt/d/Users/sunqi39/Desktop/wireless_debug-main/scripts/remote_mqtt_python_regression.mjs`
- Test: `/mnt/d/Users/sunqi39/Desktop/wireless_debug-main/scripts/remote_mqtt_python_console_smoke.mjs`

**Interfaces:**
- Produces: `CLOUD_WS_HOST`, `CLOUD_WS_PORT`, `CLOUD_WS_PUBLIC_URL`
- Produces: WebSocket endpoint `/ws/device/<device_id>`
- Produces: `start_cloud_ws_server()`
- Consumes: existing `publish_remote_ws_frame` MQTT publish logic.

- [ ] **Step 1: Write the failing test**

Update regression checks to require `websockets`, cloud WS env variables, `/ws/device/`, and browser smoke expectations for native cloud WebSocket.

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/remote_mqtt_python_regression.mjs`
Expected: FAIL until the WebSocket server and env wiring exist.

- [ ] **Step 3: Implement bridge**

Add a `websockets` server in a daemon thread. Browser binary frames publish to MQTT inbox with `channel=ws`; MQTT `pub channel=ws` frames broadcast back to connected browser clients for the same device.

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m py_compile tools/remote_mqtt_python/app.py && node scripts/remote_mqtt_python_regression.mjs`
Expected: PASS.

### Task 3: Build and Runtime Verification

**Files:**
- Modify generated frontend assets under `/mnt/d/Users/sunqi39/Desktop/wireless_debug-main/dist/orig/`

**Interfaces:**
- Consumes: Task 1 frontend build.
- Consumes: Task 2 cloud server.

- [ ] **Step 1: Build frontend**

Run: `npm run test:connection-panel && npm run build`
Expected: PASS and Vite build output under `dist/`.

- [ ] **Step 2: Sync static assets**

Copy `a.js`, `a.css`, `x.js`, gzip files, `vite.svg`, and `index.html` to firmware `dist/orig/` as `i.html`.

- [ ] **Step 3: Restart cloud server**

Install any new Python dependencies in `.venv`, restart the local cloud server, and verify health.

- [ ] **Step 4: Browser smoke**

Run: `NODE_PATH=/tmp/wireless_debug_playwright_runner/node_modules node scripts/remote_mqtt_python_console_smoke.mjs`
Expected: PASS, no requests to `192.168.4.1/api`, connection page shows native cloud WS tunnel.

- [ ] **Step 5: ESP-IDF build**

Run: `cmd.exe /C "cd /D D:\Users\sunqi39\Desktop\wireless_debug-main && C:\esp\v6.0\esp-idf\export.bat >nul 2>nul && idf.py build"`
Expected: PASS when WSL-to-Windows interop is available; if `UtilAcceptVsock` occurs, report it as environment failure.

### Task 4: User-Entered Communication Target

**Files:**
- Create: `/mnt/d/Users/sunqi39/Desktop/wireless_debug_web/src/lib/connectionTarget.ts`
- Create: `/mnt/d/Users/sunqi39/Desktop/wireless_debug_web/src/lib/apiClient.ts`
- Modify: `/mnt/d/Users/sunqi39/Desktop/wireless_debug_web/src/store/connectionStore.ts`
- Modify: `/mnt/d/Users/sunqi39/Desktop/wireless_debug_web/src/components/ConnectionPanel.tsx`
- Modify: `/mnt/d/Users/sunqi39/Desktop/wireless_debug_web/src/components/EspFilePicker.tsx`
- Modify: `/mnt/d/Users/sunqi39/Desktop/wireless_debug_web/src/components/BaudPicker.tsx`
- Test: `/mnt/d/Users/sunqi39/Desktop/wireless_debug_web/scripts/connection-target-regression.ts`

**Interfaces:**
- Produces: `resolveConnectionTarget(input: string, pageOrigin?: string): ConnectionTarget`
- Produces: `apiFetch(path: string, init?: RequestInit): Promise<Response>`
- Produces: `apiJson<T>(path: string, init?: RequestInit): Promise<T>`
- Consumes: the editable connection URL in `connectionStore.url`.

- [ ] **Step 1: Write the failing test**

Cover LAN WebSocket input, cloud WebSocket input, cloud remote page input, and invalid input.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:connection-target`
Expected: FAIL until `connectionTarget.ts` exists.

- [ ] **Step 3: Implement parser and API client**

Map `ws://192.168.4.1/ws` to LAN HTTP `http://192.168.4.1/api/*`, and `ws://server:18089/ws/device/id` to cloud HTTP `http://server:18088/remote/id/api/*`.

- [ ] **Step 4: Make UI input editable**

Show the parsed mode next to the input, persist the user-entered target, and let connect use the entered address directly.

- [ ] **Step 5: Run tests and build**

Run: `npm run test:connection-target && npm run test:connection-panel && npm run build`
Expected: PASS.
