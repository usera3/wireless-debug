import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { FrameRouter } from '../src/lib/frameRouter';
import { parseOscDataFrame } from '../src/lib/oscilloscope';

const CAPTURE_PATH = 'fixtures/cloud-waveform-integrity-20260729-144603.bin.gz';
const EXPECTED_SHA256 = 'adba1391321719d9005c8c762345973541d20303d371be45334a49b395aa0ec3';
const EXPECTED_FRAMES = 15_763;
const EXPECTED_SAMPLES = 472_890;
const EXPECTED_DISCONTINUITIES = 7;
const EXPECTED_MISSING_SAMPLES = 21_840;

const raw = gunzipSync(readFileSync(CAPTURE_PATH));
assert.equal(createHash('sha256').update(raw).digest('hex'), EXPECTED_SHA256);

const router = new FrameRouter();
const descriptors = Array.from({ length: 4 }, () => ({ typeKey: 'default-int16' as const }));
let frames = 0;
let samples = 0;
let discontinuities = 0;
let missingSamples = 0;
let previous: number | null = null;

router.setFrameLen(250);
router.onOscFrame((frame) => {
  const parsed = parseOscDataFrame(frame, descriptors, { requireCrc: true });
  assert(parsed, 'FrameRouter emitted a CRC-invalid osc frame');
  frames += 1;
  const channel = parsed.channels[0] ?? [];
  for (const value of channel) {
    if (previous != null) {
      const step = ((value & 0xffff) - (previous & 0xffff)) & 0xffff;
      if (step !== 1) {
        discontinuities += 1;
        const missing = (step - 1) & 0xffff;
        missingSamples += missing;
      }
    }
    previous = value;
    samples += 1;
  }
});

for (let offset = 0; offset < raw.length; offset += 2048) {
  router.feed(raw.subarray(offset, Math.min(raw.length, offset + 2048)));
}

assert.equal(frames, EXPECTED_FRAMES, 'all CRC-recoverable osc frames must reach the parser');
assert.equal(samples, EXPECTED_SAMPLES, 'recovered osc frames must retain every sample');
assert.equal(discontinuities, EXPECTED_DISCONTINUITIES, 'only true transport gaps may remain');
assert.equal(missingSamples, EXPECTED_MISSING_SAMPLES, 'parser recovery must not mask true loss');

console.log(JSON.stringify({
  capture: CAPTURE_PATH,
  bytes: raw.length,
  frames,
  samples,
  discontinuities,
  missingSamples,
}, null, 2));
