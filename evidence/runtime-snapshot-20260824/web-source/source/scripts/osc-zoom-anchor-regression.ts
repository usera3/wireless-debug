import assert from 'node:assert/strict';
import { getPlotRelativePosition, zoomRange } from '../src/lib/oscZoom';

const plotRect = { left: 200, top: 120 };
const pointer = getPlotRelativePosition(520, 370, plotRect);
assert.deepEqual(
  pointer,
  { x: 320, y: 250 },
  'uPlot anchors must use coordinates relative to the plot overlay, not the root plus a second plot offset',
);

const plotWidth = 800;
const pointerRatio = pointer.x / plotWidth;
let min = 10;
let max = 20;

for (let i = 0; i < 12; i++) {
  const anchor = min + (max - min) * pointerRatio;
  const next = zoomRange(min, max, anchor, 0.85, 0.001);
  const nextAnchor = next.min + (next.max - next.min) * pointerRatio;
  assert.ok(
    Math.abs(nextAnchor - anchor) < 1e-12,
    `zoom ${i + 1} moved the cursor anchor by ${nextAnchor - anchor}`,
  );
  min = next.min;
  max = next.max;
}

console.log('osc zoom anchor regression passed');
