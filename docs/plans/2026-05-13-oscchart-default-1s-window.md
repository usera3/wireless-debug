# OscChart Default 1s Window Implementation Plan

> **For Claude:** Implement this directly without TDD; verify with typecheck, build, and manual UI confirmation.

**Goal:** Update `OscChart` so startup X-axis defaults to `0~1s`, begins rolling only after data reaches `1s`, and keeps the existing Y-axis default of `-5000~5000` with overflow-based auto expansion.

**Architecture:** Keep the existing `uPlot`-based `OscChart` component and adjust only its internal X/Y state machine helpers. Replace the hard-coded `10s` startup/follow threshold with `1s`, preserve `manual` mode behavior, and keep page-level consumers unchanged except for validating that they already pass `running`.

**Tech Stack:** React, TypeScript, `uPlot`, Vite

---

### Task 1: Update OscChart default X/Y state behavior

**Files:**
- Modify: `src/components/OscChart.tsx:83-456`
- Verify: manual browser verification via existing oscilloscope pages

**Step 1: Inspect current implementation**

Confirm the current implementation still uses `10s` defaults:
- `defaultXWindowRef` is `10`
- startup view is `0~10s`
- follow threshold is `10s`

**Step 2: Implement the change**

Modify `src/components/OscChart.tsx` to:
- change `defaultXWindowRef` from `10` to `1`
- keep `defaultYRangeRef` at `{ min: -5000, max: 5000 }`
- keep `waiting/following/manual` X state model
- ensure `moveToLatestKeepingSpan()` keeps `0~1s` before data reaches `1s`
- ensure `syncXModeToData()` switches from `waiting` to `following` once latest X reaches `1s`
- preserve manual mode and existing wheel/drag behavior

**Step 3: Verify the change**

Verify with:
- `npx tsc --noEmit`
- `npm run build`
- manual UI check that startup is `0~1s`, blank right side exists before `1s`, and rolling begins at `1s`

### Task 2: Verify chart consumers remain compatible

**Files:**
- Modify: none expected
- Verify: `src/components/OscilloscoperPage.tsx`
- Verify: `src/components/ModbusOscPage.tsx`

**Step 1: Inspect consumers**

Check both consumers for any hard-coded `10s` assumptions and confirm they continue to pass `channels`, `sampleInterval`, optional `labels`, and `running` correctly.

**Step 2: Implement only if needed**

If a consumer has a hard-coded assumption or missing prop, update it. Otherwise keep this task verification-only.

**Step 3: Verify compatibility**

Rebuild and confirm both oscilloscope entry pages still compile and render.