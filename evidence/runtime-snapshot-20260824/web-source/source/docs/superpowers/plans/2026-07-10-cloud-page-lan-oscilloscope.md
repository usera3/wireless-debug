# Cloud Page LAN Oscilloscope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the cloud-hosted shared web UI clearly use the ESP32 LAN WebSocket for high-speed address oscilloscope operation when the communication target is `192.168.4.1`, while retaining cloud forwarding as a supported fallback.

**Architecture:** Keep the existing single `wsClient` and `resolveConnectionTarget()` transport selection. Add a pure presentation helper for oscilloscope link metadata, render the active link on the address oscilloscope page, and stop/reset oscilloscope state whenever the active WebSocket disconnects so reconnecting to another target cannot reuse stale state.

**Tech Stack:** React 18, TypeScript, Zustand, native WebSocket, Vite, Playwright.

## Global Constraints

- The same frontend build must continue to run from both ESP32 storage and the cloud server.
- LAN mode must connect directly to `ws://192.168.4.1/ws` and must not pass waveform data through MQTT.
- Cloud oscilloscope remains available and is labelled as a public-network fallback.
- Do not add waveform interpolation or a cloud jitter buffer.
- Switching transports must clear the previous oscilloscope run and parser state.

---

### Task 1: Oscilloscope Transport Presentation

**Files:**
- Create: `src/lib/oscTransport.ts`
- Create: `scripts/osc-transport-regression.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `ConnectionTarget` from `src/lib/connectionTarget.ts`.
- Produces: `describeOscTransport(target)` returning mode, title, detail, and tone.

- [x] Write regression cases for LAN, cloud, and invalid targets.
- [x] Run the new test and verify it fails because the helper does not exist.
- [x] Implement the minimal pure helper.
- [x] Run the regression and existing connection-target tests.

### Task 2: Address Oscilloscope Link Indicator and Cleanup

**Files:**
- Modify: `src/components/OscilloscoperPage.tsx`
- Modify: `src/hooks/useOscController.ts`
- Create: `scripts/osc-page-link-regression.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `useConnectionStore.url`, `connected`, `describeOscTransport()` and existing `stop()`.
- Produces: visible `局域网高速通道` or `云端转发通道` status and automatic cleanup after disconnection.

- [x] Write source-level regression assertions for both link labels and disconnect cleanup.
- [x] Run the test and verify it fails.
- [x] Render the active transport indicator beside oscilloscope controls.
- [x] Stop and reset an active address oscilloscope when WebSocket connectivity is lost.
- [x] Run focused regressions and production build.

### Task 3: Deploy and Verify Both Paths

**Files:**
- Update generated frontend build under firmware `dist/orig/`.
- Update cloud static frontend under `/home/ubuntu/wireless-debug-cloud/dist/orig/`.

- [x] Build the frontend and copy the generated assets into firmware `dist/orig/`.
- [x] Deploy only cloud static assets; do not restart PostgreSQL or Mosquitto.
- [x] Open the cloud-hosted page, select LAN target `http://192.168.4.1`, and verify the browser WebSocket URL is `ws://192.168.4.1/ws`.
- [x] Start the address oscilloscope and measure continuous LAN frame delivery.
- [x] Switch back to a cloud device and verify cloud fallback remains usable and correctly labelled.
