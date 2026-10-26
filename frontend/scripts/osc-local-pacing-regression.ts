import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { FrameRouter } from '../src/lib/frameRouter';
import { OscJitterBuffer } from '../src/lib/oscJitterBuffer';
import { parseOscDataFrame } from '../src/lib/oscilloscope';

const capturePath = process.argv[2] ?? 'fixtures/osc-c52c-local-30s.json.gz';
const TICK_MS = 50;
const TARGET_LATENCY_MS = 200;
const RESUME_LATENCY_MS = 100;

type Capture = {
  config: {
    frame_len: number;
    sample_rate: number;
    channel_count: number;
    param_type?: number;
    running_at_ms?: number;
  };
  analysis?: {
    ch1_samples: number;
  };
  chunks: Array<{
    t_ms: number;
    data_b64: string;
  }>;
};

const capture = JSON.parse(
  gunzipSync(readFileSync(capturePath)).toString('utf8'),
) as Capture;
const timelineOriginMs = capture.config.running_at_ms ?? 0;
const channelNos = Array.from(
  { length: capture.config.channel_count },
  (_, index) => index + 1,
);
const descriptors = channelNos.map(() => ({
  typeKey: 'default-int16' as const,
}));
const router = new FrameRouter();
const playback = new OscJitterBuffer();
const expected: number[] = [];
const played: number[] = [];
const steadyDrainCounts: number[] = [];
let firstDrainAtMs: number | null = null;
let firstDrainBufferedSamples: number | null = null;
let emptySteadyTicks = 0;
let nextTickMs = 0;

router.setFrameLen(capture.config.frame_len);
router.onOscFrame((frame) => {
  const parsed = parseOscDataFrame(frame, descriptors, { requireCrc: true });
  assert.ok(parsed, 'captured frame must remain parseable');
  expected.push(...(parsed.channels[0] ?? []));
  playback.appendBatch(new Map(parsed.channels.map((samples, index) => [
    channelNos[index],
    samples,
  ])));
});
playback.reset({
  channelNos,
  sampleRate: capture.config.sample_rate,
  targetLatencyMs: TARGET_LATENCY_MS,
  resumeLatencyMs: RESUME_LATENCY_MS,
  tickMs: TICK_MS,
  nowMs: 0,
});

function drainAt(nowMs: number, measureCadence: boolean) {
  const bufferedBeforeDrain = playback.bufferedSamples;
  const drained = playback.drainDue(nowMs);
  if (!drained) {
    if (measureCadence && firstDrainAtMs != null) emptySteadyTicks++;
    return;
  }

  const samples = drained.batch.get(1) ?? [];
  if (firstDrainAtMs == null) {
    firstDrainAtMs = nowMs;
    firstDrainBufferedSamples = bufferedBeforeDrain;
  }
  if (measureCadence) steadyDrainCounts.push(samples.length);
  played.push(...samples);
}

for (const chunk of capture.chunks) {
  const relativeTimeMs = Math.max(0, chunk.t_ms - timelineOriginMs);
  while (nextTickMs <= relativeTimeMs) {
    drainAt(nextTickMs, true);
    nextTickMs += TICK_MS;
  }
  router.feed(Buffer.from(chunk.data_b64, 'base64'));
}

for (let guard = 0; playback.bufferedSamples > 0 && guard < 2000; guard++) {
  drainAt(nextTickMs, false);
  nextTickMs += TICK_MS;
}
const tail = playback.drainAll();
if (tail) played.push(...(tail.batch.get(1) ?? []));

const theoreticalPerTick = capture.config.sample_rate * TICK_MS / 1000;
const mean = steadyDrainCounts.reduce((sum, count) => sum + count, 0) / steadyDrainCounts.length;
const variance = steadyDrainCounts.reduce(
  (sum, count) => sum + (count - mean) ** 2,
  0,
) / steadyDrainCounts.length;
const standardDeviation = Math.sqrt(variance);

if (capture.analysis?.ch1_samples != null) {
  assert.equal(expected.length, capture.analysis.ch1_samples);
}
assert.deepEqual(played, expected, 'paced playback must preserve every sample in order');
const targetSamples = capture.config.sample_rate * TARGET_LATENCY_MS / 1000;
assert.ok(firstDrainAtMs != null && firstDrainAtMs <= 300,
  `local playback should begin promptly after filling its reserve, got ${firstDrainAtMs}`);
assert.ok(firstDrainBufferedSamples != null && firstDrainBufferedSamples >= targetSamples,
  `local playback started with ${firstDrainBufferedSamples} samples, expected at least ${targetSamples}`);
assert.equal(emptySteadyTicks, 0, 'the 200 ms local reserve must cover every measured receive gap');
assert.ok(steadyDrainCounts.length > 500, 'the capture must exercise sustained paced playback');
assert.ok(Math.min(...steadyDrainCounts) >= theoreticalPerTick * 0.98);
assert.ok(Math.max(...steadyDrainCounts) <= theoreticalPerTick * 1.02);
assert.ok(standardDeviation < theoreticalPerTick * 0.01,
  `paced output should be stable, standard deviation was ${standardDeviation}`);

console.log(JSON.stringify({
  capture: capturePath,
  firstDrainAtMs,
  firstDrainBufferedSamples,
  emptySteadyTicks,
  steadyTicks: steadyDrainCounts.length,
  minDrain: Math.min(...steadyDrainCounts),
  maxDrain: Math.max(...steadyDrainCounts),
  meanDrain: Number(mean.toFixed(3)),
  standardDeviation: Number(standardDeviation.toFixed(3)),
  samples: played.length,
}, null, 2));
