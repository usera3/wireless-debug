# Unified Wireless Debug Site Design

## Context

Wireless Debug now has two user-facing web surfaces:

- `wireless_debug_web`: Vite + React + TypeScript, built into ESP32 SPIFFS as `dist/orig/i.html` and also served by the cloud under `/remote/<device_id>/orig/i.html`.
- `wireless_debug-main/tools/remote_mqtt_python/static/cloud.html`: a standalone hand-written cloud dashboard served at `/cloud.html`.

This split causes duplicated design work, inconsistent navigation, and drift between local ESP32 use and cloud use. The next phase will make `wireless_debug_web` the only frontend application source while keeping the current Python cloud backend as the production backend for login, device inventory, remote proxying, and MQTT/WebSocket bridging.

## Options Considered

### Option A: Keep Two Frontends And Share CSS

Reuse the Sub2API-like style tokens from `cloud.html` inside the React app, but keep `cloud.html` as a standalone page.

Trade-off: lowest short-term risk, but it does not meet the "one site" goal. Cloud dashboard and device console would still diverge in routing, components, and behavior.

### Option B: Move Everything To A Spring Boot + React App

Use the existing Spring Boot prototype as the single backend and React frontend host.

Trade-off: cleaner enterprise shape long term, but it is too much migration right now. The Python cloud service already works with MQTT, remote WebSocket, login, deployment, and nginx. Replacing it before the frontend is unified adds risk without improving the immediate user experience.

### Option C: Use The Existing Vite + React App As The Single Frontend

Extend `wireless_debug_web` with a cloud shell and device directory pages. Build one static bundle. The same bundle can run from:

- ESP32 local AP: direct local device mode, default target `http://192.168.4.1`.
- Cloud dashboard: cloud platform mode, using `/api/devices`, `/api/health`, and `/remote/<device_id>`.
- Cloud remote console: cloud device mode, using injected `window.__WIRELESS_REMOTE_DEVICE_ID` and `window.__WIRELESS_REMOTE_WS_URL`.

Recommendation: choose Option C. It preserves the current working firmware and Python backend while removing the duplicated frontend.

## Selected Design

### Runtime Modes

The React app will detect a runtime mode from URL and injected globals:

- `local-device`: ESP32 serves the app from `/orig/i.html`; default connection target is `http://192.168.4.1`.
- `cloud-platform`: cloud serves the app at `/cloud` or `/cloud.html`; default page is device overview and device management.
- `cloud-device`: cloud serves the app at `/remote/<device_id>/orig/i.html`; default connection target is the selected device through cloud WebSocket/API proxy.

Users can still override the communication entry in the connection panel. Local mode means the currently connected ESP32 at `192.168.4.1`; cloud mode means a selected online device.

### Navigation

The app will use one shell component with mode-aware navigation:

- Local and cloud-device modes show the device tools: dashboard, address oscilloscope, parameter oscilloscope, parameter edit, firmware flashing, connection settings.
- Cloud-platform mode shows platform tools: overview, device management, connection management, message center, events, system settings.
- A cloud-platform device row opens the same React bundle in `cloud-device` mode for that device.

This keeps local device control and cloud device control visually identical while allowing the cloud platform dashboard to remain denser and multi-device oriented.

### Backend Responsibilities

The Python cloud backend remains responsible for:

- Session login/logout and route protection.
- `/api/devices`, `/api/devices/<id>`, `/api/devices/<id>/history`, device name/note APIs.
- `/remote/<device_id>/api/...` proxy behavior.
- `/ws/device/<device_id>` browser WebSocket fanout.
- Static serving of the React bundle for cloud platform and cloud device routes.

The ESP32 firmware remains responsible for:

- Serving the same built React bundle from SPIFFS.
- Local `/api/...`, `/excel/...`, and `/ws` APIs.
- WiFi/BLE/UART/device behavior already implemented in firmware.

### Build And Deployment

`wireless_debug_web` stays the source of truth. Its production build produces:

- `i.html`, `a.js`, `a.css`, gzip variants, and lazy chunks.
- One copy for ESP32 SPIFFS under `wireless_debug-main/dist/orig`.
- One copy mounted or copied into the Python cloud service for `/cloud` and `/remote/<device_id>/orig`.

The cloud backend should stop depending on a hand-maintained `static/cloud.html` dashboard once the React cloud platform page is ready.

### Error Handling

- If a cloud-platform API call returns 401, route to `/login`.
- If a selected cloud device is offline, show offline state and disable direct control actions.
- If HTTPS cloud pages access local `http://192.168.4.1`, use Private Network Access headers where available and show a clear permission/action prompt when the browser blocks it.
- If remote WebSocket cannot connect, keep the current red/green status indicator and surface the concrete endpoint and error.

### Testing Requirements

Before firmware flashing or cloud deployment:

- `npm run build` must pass in `wireless_debug_web`.
- Connection target unit regressions must pass for local, cloud, and custom modes.
- A Playwright smoke test must load the app in three modes: local-device URL, cloud-platform URL, cloud-device URL.
- Cloud auth regression must prove `/cloud` and `/remote/<id>/orig/i.html` cannot bypass login.
- Remote console HTTPS regression must prove injected WebSocket uses `wss://wd.claudcode.xyz/ws/device/<id>` on HTTPS.

## Scope Boundaries

This phase will not replace the Python backend with Spring Boot. It will also not redesign firmware WiFi modes, MQTT transport, or low-level oscilloscope data flow. Those systems stay as-is unless the frontend unification exposes a blocking integration bug.

## Success Criteria

- There is one React source tree for local ESP32 UI, cloud dashboard UI, and cloud remote device UI.
- The cloud dashboard no longer depends on the standalone `tools/remote_mqtt_python/static/cloud.html` page for its main experience.
- Users can switch between local `192.168.4.1` and cloud device communication from the same connection UI.
- Existing address oscilloscope, parameter oscilloscope, parameter table upload, and connection settings behavior remains at least as good as the current flashed local page.
