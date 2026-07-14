# Remote MQTT Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the remote MQTT dashboard into a compact professional operations console without changing server APIs.

**Architecture:** Keep the one-file static dashboard. Replace card-heavy DOM and render helpers with a device strip, status table renderer, command panel, and log stream.

**Tech Stack:** Static HTML/CSS/JavaScript served by Express, MQTT server APIs, SSE updates, Node static regression script, Playwright verification.

## Global Constraints

- Do not introduce a frontend build framework.
- Preserve existing MQTT command endpoint wiring and command types.
- Keep Chinese-first copy.
- No nested cards.
- Add explicit focus, pending, disabled, empty, success, error, and dark-mode states.

---

### Task 1: Regression Contract

**Files:**
- Modify: `scripts/remote_mqtt_server_regression.mjs`

**Interfaces:**
- Consumes: current static file contents.
- Produces: failing assertions for the new dashboard architecture before implementation.

- [ ] Write assertions requiring `device-state-strip`, `status-table`, Chinese-first technical labels, `:focus-visible`, `prefers-color-scheme: dark`, and existing command behavior.
- [ ] Write assertions rejecting `summary-grid`, `summary-card`, `status-section`, `renderSummary`, and `renderStatusSections`.
- [ ] Run `node scripts/remote_mqtt_server_regression.mjs` and verify it fails before editing the dashboard.

### Task 2: Dashboard Redesign

**Files:**
- Modify: `tools/remote_mqtt/server/public/index.html`

**Interfaces:**
- Consumes: `/api/devices/esp32-001/status`, `/api/devices/esp32-001/command`, `/events`.
- Produces: same controls and command payloads as the existing dashboard.

- [ ] Replace summary cards with one `device-state-strip`.
- [ ] Replace nested status cards with one `status-table` renderer.
- [ ] Keep command buttons and inputs wired by `data-command` and `data-requires-online`.
- [ ] Replace `renderSummary` and `renderStatusSections` with `renderDeviceStrip` and `renderStatusTable`.
- [ ] Add explicit focus-visible and dark-mode CSS.

### Task 3: Verification

**Files:**
- Test: `scripts/remote_mqtt_server_regression.mjs`

**Interfaces:**
- Consumes: redesigned page.
- Produces: repeatable verification artifacts and screenshots.

- [ ] Run `node scripts/remote_mqtt_server_regression.mjs` and verify it passes.
- [ ] Run `git diff --check`.
- [ ] Use Playwright against `http://127.0.0.1:3000` to capture desktop and mobile screenshots.
- [ ] Confirm no horizontal overflow and all primary controls remain keyboard-reachable.
