# Connection Target Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace raw-address-first connection setup with local, online cloud device, and custom target choices while retaining manual debugging access.

**Architecture:** Keep the existing connection store as the source of truth. Add pure helpers that classify targets and build cloud WebSocket URLs, expose the cloud device directory under a non-proxied platform route, and let `ConnectionPanel` translate user-friendly selections into the existing URL state.

**Tech Stack:** React, TypeScript, Zustand, Flask, existing regression scripts.

## Global Constraints

- Local ESP32 target is fixed at `http://192.168.4.1`.
- Cloud dropdown lists only online devices and displays `display_name`.
- Custom URL input remains available.
- ESP32 `AUTO/WIFI/BLE` controls remain and are renamed to `数据转发方式`.
- Do not expose or persist cloud credentials in frontend source.

---

### Task 1: Target Selection Logic

**Files:**
- Create: `src/lib/connectionSelection.ts`
- Create: `scripts/connection-selection-regression.ts`
- Modify: `package.json`

- [ ] Write failing tests for target classification, online filtering, display names, and cloud WS URL construction.
- [ ] Implement the pure helpers.
- [ ] Run the regression test.

### Task 2: Connection Panel

**Files:**
- Modify: `src/components/ConnectionPanel.tsx`
- Modify: `scripts/connection-panel-copy-regression.ts`

- [ ] Add local/cloud/custom segmented controls.
- [ ] Fetch `/platform/api/devices` on cloud pages and render online devices by display name.
- [ ] Translate selections into the existing URL and connection flow.
- [ ] Rename communication mode to data forwarding mode.
- [ ] Run connection regressions.

### Task 3: Platform Device Directory Route

**Files:**
- Modify: `tools/remote_mqtt_python/app.py`

- [ ] Add `/platform/api/devices` as an alias for the existing device list response.
- [ ] Confirm the remote console rewrite script leaves the route untouched.

### Task 4: Build And Deploy

**Files:**
- Update generated frontend assets in firmware `dist/orig/`.
- Deploy generated assets and Flask service to the cloud server.

- [ ] Run all connection regressions and `npm run build`.
- [ ] Sync cloud assets and restart only the cloud container if backend code changes.
- [ ] Sync firmware assets and run the incremental ESP-IDF build.
- [ ] Verify cloud device selection and local target resolution.
