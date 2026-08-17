# uPlot OscChart Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current LightningChart-based waveform renderer with a uPlot-based `OscChart` implementation that preserves existing props, keeps full history, supports X-axis follow/pause behavior, and supports manual Y-axis zoom with double-click reset to auto.

**Architecture:** Keep `OscChart` as the single chart integration point used by both oscilloscope pages. Replace the internal chart engine with `uPlot`, maintain an internal aligned data cache in the component, and separate X follow-state from Y auto/manual state so new data does not override user-controlled Y zoom.

**Tech Stack:** React, TypeScript, Vite, uPlot, existing Tailwind layout, npm scripts (`build`, `lint`), manual browser verification.

---

### Task 1: Replace the chart dependency

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

**Step 1: Inspect the current dependency state**

Run: `npm ls @lightningchart/lcjs uplot`
Expected:
- `@lightningchart/lcjs` is installed
- `uplot` is missing

**Step 2: Update the dependency set**

- Remove `@lightningchart/lcjs` from `dependencies` in `package.json`
- Add `uplot` to `dependencies` in `package.json`
- Refresh `package-lock.json` by installing the new dependency set

**Step 3: Verify the dependency change**

Run: `npm ls @lightningchart/lcjs uplot`
Expected:
- `uplot` is installed
- `@lightningchart/lcjs` is no longer present in the dependency tree

**Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: replace lightningchart with uplot"
```

### Task 2: Rebuild `OscChart` around uPlot initialization and teardown

**Files:**
- Modify: `src/components/OscChart.tsx`
- Check: `src/components/OscilloscoperPage.tsx:1-68`
- Check: `src/components/ModbusOscPage.tsx:1-122`

**Step 1: Replace the chart engine wiring**

In `src/components/OscChart.tsx`:
- Remove all LightningChart imports and types
- Add the `uplot` import and stylesheet import if required by the package usage pattern
- Keep the public props unchanged:
  - `channels: Map<number, number[]>`
  - `sampleInterval: number`
  - `labels?: Map<number, string>`
- Keep demo data fallback support unless it becomes clearly unnecessary
- Replace the chart instance ref with a `uPlot` instance ref
- Recreate the chart only when the channel set or `sampleInterval` changes
- Destroy the old `uPlot` instance during cleanup before creating a new one
- Keep the same outer container element so page layout does not change

**Step 2: Verify the new initialization layer**

Run: `npx tsc --noEmit`
Expected:
- No TypeScript errors from imports, instance refs, or lifecycle setup

**Step 3: Commit**

```bash
git add src/components/OscChart.tsx
git commit -m "refactor: initialize osc chart with uplot"
```

### Task 3: Implement aligned data cache and incremental updates

**Files:**
- Modify: `src/components/OscChart.tsx`

**Step 1: Add the internal cache and incremental sync logic**

In `src/components/OscChart.tsx`:
- Represent chart data in uPlot format: `[xData, ch1Data, ch2Data, ...]`
- Maintain stable channel ordering from sorted channel numbers
- Maintain `renderedCountsRef: Map<number, number>`
- On update per channel:
  - if new length equals rendered length: skip
  - if new length is greater: append only new tail values into the cached arrays
  - if new length is smaller: rebuild the full aligned cache from current `channels`
- For channels with shorter arrays than the longest X array, fill missing positions with `null`
- After cache updates, call `uPlot.setData()` with the aligned arrays
- Preserve full history; do not window or truncate data

**Step 2: Verify the data update path**

Run: `npx tsc --noEmit`
Expected:
- No TypeScript errors from cache shaping, null handling, or `uPlot.setData()` usage

**Step 3: Commit**

```bash
git add src/components/OscChart.tsx
git commit -m "feat: add incremental uplot waveform updates"
```

### Task 4: Implement X follow-state and Y auto/manual separation

**Files:**
- Modify: `src/components/OscChart.tsx`

**Step 1: Add the interaction state rules**

In `src/components/OscChart.tsx`:
- Add `followLatestRef` to track whether X should auto-follow latest data
- Add `yAutoRef` to track whether Y is currently automatic
- On data updates:
  - if still following latest, move X range to the newest tail
  - if user has moved away from the tail, keep the current X scale unchanged
- Detect manual Y-axis range changes and switch `yAutoRef` to `false`
- On double-click, reset Y scale to the visible data range and set `yAutoRef` back to `true`
- Keep X and Y state handling independent so resetting Y does not move X to the latest tail
- Do not add custom Y-axis control buttons

**Step 2: Verify the interaction behavior manually**

Manual checks in browser:
- On live updates while at the tail, X follows latest data
- After dragging X away from the tail, new data arrives without moving the view
- Manual Y zoom persists as new data arrives
- Double-click restores Y to auto-range only

**Step 3: Commit**

```bash
git add src/components/OscChart.tsx
git commit -m "feat: preserve x follow and manual y zoom in uplot"
```

### Task 5: Verify both chart entry pages still work

**Files:**
- Check: `src/components/OscilloscoperPage.tsx:1-68`
- Check: `src/components/ModbusOscPage.tsx:1-122`
- Check: `src/components/OscChart.tsx`

**Step 1: Validate both integration points**

Manual checks:
- Open the direct oscilloscope page and confirm chart creation works
- Open the parameter oscilloscope page and confirm alias labels map correctly to series
- Confirm there are no missing labels, broken empty-state handling, or layout regressions

**Step 2: Fix only discovered integration issues**

- Keep calling sites unchanged
- Ensure empty/demo fallback handling still behaves sensibly
- Ensure chart container still fills the available panel height

**Step 3: Verify the integration and build**

Run:
- `npx tsc --noEmit`
- `npm run build`

Expected:
- TypeScript passes
- Vite production build passes
- No unresolved LightningChart references remain in active code

**Step 4: Commit**

```bash
git add src/components/OscChart.tsx package.json package-lock.json
git commit -m "feat: migrate oscilloscope waveform chart to uplot"
```

### Task 6: Final cleanup and completion checks

**Files:**
- Check: `package.json`
- Check: `src/components/OscChart.tsx`
- Check: `src/components/OscilloscoperPage.tsx`
- Check: `src/components/ModbusOscPage.tsx`

**Step 1: Audit for leftover LightningChart references**

Run:
- `rg "lightningchart|@lightningchart/lcjs" .`
Expected before cleanup:
- Any remaining matches indicate incomplete migration

**Step 2: Remove remaining migration leftovers**

- Remove any leftover LightningChart-specific comments, imports, logic, or stale wording
- Keep the change set scoped to the migration only

**Step 3: Run final verification**

Run:
- `rg "lightningchart|@lightningchart/lcjs" .`
- `npx tsc --noEmit`
- `npm run build`

Expected:
- No code references to LightningChart remain in active implementation
- TypeScript passes
- Build passes

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: finalize uplot chart migration"
```