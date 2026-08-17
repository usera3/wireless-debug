# Cloud Oscilloscope Fast Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce repeated cloud oscilloscope startup latency and make browser delivery more even without fabricating samples.

**Architecture:** Add a target-scoped capability cache and an explicit startup policy in the web client. Keep strict discovery for cold starts and local connections, use cached fire-and-order configuration for warm cloud starts, and halve cloud browser chunk size and interval while preserving throughput.

**Tech Stack:** React, TypeScript, Zustand, WebSocket, Python asyncio WebSocket fanout, Docker Compose, Playwright.

## Global Constraints

- Never synthesize or interpolate waveform samples.
- Keep capability data isolated by resolved connection target.
- Preserve strict local-network startup behavior.
- Register waveform reception before sending the start command.

---

### Task 1: Capability Cache And Startup Policy

**Files:**
- Create: `src/lib/oscCapabilityCache.ts`
- Create: `scripts/osc-capability-cache-regression.ts`
- Modify: `package.json`

- [ ] Write a regression covering valid cache round-trip, target isolation, expiry/version rejection, and cloud/local startup policy.
- [ ] Run the regression and confirm it fails because the module is missing.
- [ ] Implement validated local-storage cache helpers and pure startup-policy selection.
- [ ] Run the regression and confirm it passes.

### Task 2: Fast Cloud Start

**Files:**
- Modify: `src/hooks/useOscController.ts`
- Create: `scripts/osc-fast-start-regression.ts`
- Modify: `package.json`

- [ ] Write a source-level regression requiring receive-handler registration before start and cached cloud configuration without per-channel ACK waits.
- [ ] Run the regression and confirm it fails.
- [ ] Integrate target resolution, capability cache, strict cold discovery, and ordered warm-cloud command dispatch.
- [ ] Run osc request, realtime buffer, transport, and fast-start regressions.

### Task 3: Smoother Cloud Browser Delivery

**Files:**
- Modify: `tools/remote_mqtt_python/docker-compose.yml`
- Modify: `scripts/cloud_ws_fanout_regression.py`

- [ ] Change the regression expectation to 2048-byte chunks at a 20ms minimum interval and confirm failure.
- [ ] Update deployment defaults while retaining environment overrides.
- [ ] Run the fanout and keepalive regressions.

### Task 4: Build, Deploy, And Hardware Acceptance

**Files:**
- Generated: `dist/**`
- Synced: firmware `dist/**`
- Deployed: cloud `tools/remote_mqtt_python/**`

- [ ] Run TypeScript build and all focused regressions.
- [ ] Sync the built web assets into the firmware project without flashing a firmware-only change unnecessarily.
- [ ] Deploy the cloud service and confirm effective environment values.
- [ ] Run a cold/warm startup timing probe and the 75-second cloud continuity probe.
- [ ] Record click-to-running latency, first waveform latency, frames per five seconds, and disconnect/error counters.
