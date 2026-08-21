import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { FrameRouter } from '../src/lib/frameRouter';
import { OscHistory } from '../src/lib/oscHistory';
import { OscJitterBuffer } from '../src/lib/oscJitterBuffer';
import { parseOscDataFrame } from '../src/lib/oscilloscope';

const EXPECTED_STREAM_SHA256 = '4557c782316db3206f7f07f9c0e2062ddfae8937993d2511024b2fcb963e36ef';
const EXPECTED_STREAM_BYTES = 2_500_761;
const EXPECTED_FRAMES = 10_002;
const EXPECTED_CH1_SAMPLES = 300_060;
const TICK_MS = 50;

type CaptureChunk = {
  t_ms: number;
  data_b64: string;
};

type Capture = {
  config: {
    frame_len: number;
    sample_rate: number;
    channel_count: number;
    duration_seconds: number;
  };
  analysis: {
    logical_frame_hashes_sha256: string[];
    ch1_samples: number;
  };
  chunks: CaptureChunk[];
};

type ReplayChunk = {
  tMs: number;
  data: Uint8Array;
};

type ReplayResult = {
  mode: string;
  chunks: number;
  bytes: number;
  frames: number;
  ch1Samples: number;
  historySamples: number;
  historyNullSamples: number;
};

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function originalChunks(capture: Capture): ReplayChunk[] {
  return capture.chunks.map((chunk) => ({
    tMs: chunk.t_ms,
    data: Buffer.from(chunk.data_b64, 'base64'),
  }));
}

function fixedSizeChunks(capture: Capture, chunkBytes: number): ReplayChunk[] {
  const source = Buffer.concat(originalChunks(capture).map((chunk) => Buffer.from(chunk.data)));
  const chunks: ReplayChunk[] = [];
  for (let offset = 0; offset < source.length; offset += chunkBytes) {
    const end = Math.min(source.length, offset + chunkBytes);
    chunks.push({
      tMs: capture.config.duration_seconds * 1000 * end / source.length,
      data: source.subarray(offset, end),
    });
  }
  return chunks;
}

function oneChunk(capture: Capture): ReplayChunk[] {
  return [{
    tMs: capture.config.duration_seconds * 1000,
    data: Buffer.concat(originalChunks(capture).map((chunk) => Buffer.from(chunk.data))),
  }];
}

function runReplay(mode: string, capture: Capture, chunks: ReplayChunk[]): ReplayResult {
  const router = new FrameRouter();
  const history = new OscHistory();
  const jitter = new OscJitterBuffer();
  const channels = Array.from({ length: capture.config.channel_count }, (_, index) => ({
    channelNo: index + 1,
    typeKey: 'default-int16' as const,
  }));
  const descriptors = channels.map(({ typeKey }) => ({ typeKey }));
  const expectedHashes = capture.analysis.logical_frame_hashes_sha256;
  const frameHashes: string[] = [];
  const baseTimeMs = 1_000;
  let currentTimeMs = baseTimeMs;
  let nextTickMs = 0;
  let parsedCh1Samples = 0;

  router.setFrameLen(capture.config.frame_len);
  history.reset(channels.map((channel) => channel.channelNo), capture.config.sample_rate, 60);
  jitter.reset({
    channelNos: channels.map((channel) => channel.channelNo),
    sampleRate: capture.config.sample_rate,
    targetLatencyMs: 300,
    resumeLatencyMs: 100,
    tickMs: TICK_MS,
    nowMs: baseTimeMs,
  });
  router.onOscFrame((frame) => {
    frameHashes.push(sha256(frame));
    const parsed = parseOscDataFrame(frame, descriptors, { requireCrc: true });
    assert(parsed, `${mode}: router emitted an invalid frame`);
    parsedCh1Samples += parsed.channels[0]?.length ?? 0;
    jitter.appendBatch(new Map(parsed.channels.map((samples, index) => [
      channels[index].channelNo,
      samples,
    ])));
  });

  const flushAt = (relativeMs: number) => {
    currentTimeMs = baseTimeMs + relativeMs;
    const drained = jitter.drainDue(currentTimeMs);
    if (drained) history.appendBatch(drained.batch);
  };

  for (const chunk of chunks) {
    while (nextTickMs <= chunk.tMs) {
      flushAt(nextTickMs);
      nextTickMs += TICK_MS;
    }
    currentTimeMs = baseTimeMs + chunk.tMs;
    router.feed(chunk.data);
  }

  for (let guard = 0; jitter.bufferedSamples > 0 && guard < 2000; guard++) {
    flushAt(nextTickMs);
    nextTickMs += TICK_MS;
  }
  const finalDrain = jitter.drainAll();
  if (finalDrain) history.appendBatch(finalDrain.batch);

  const exported = history.exportColumns([1]).columns[0];
  const nullSamples = exported.filter((value) => value == null).length;
  const result: ReplayResult = {
    mode,
    chunks: chunks.length,
    bytes: chunks.reduce((sum, chunk) => sum + chunk.data.length, 0),
    frames: frameHashes.length,
    ch1Samples: parsedCh1Samples,
    historySamples: exported.length,
    historyNullSamples: nullSamples,
  };

  assert.equal(frameHashes.length, EXPECTED_FRAMES, `${mode}: frame count`);
  assert.deepEqual(frameHashes, expectedHashes, `${mode}: frame order/hash`);
  assert.equal(parsedCh1Samples, EXPECTED_CH1_SAMPLES, `${mode}: parsed CH1 samples`);
  assert.equal(exported.length, parsedCh1Samples, `${mode}: retained CH1 samples`);
  assert.equal(nullSamples, 0, `${mode}: address history must remain contiguous`);
  return result;
}

const capturePath = process.argv[2] ?? 'fixtures/osc-c52c-local-30s.json.gz';
const captureFile = readFileSync(capturePath);
const captureText = capturePath.endsWith('.gz')
  ? gunzipSync(captureFile).toString('utf8')
  : captureFile.toString('utf8');
const capture = JSON.parse(captureText) as Capture;
const sourceBytes = Buffer.concat(originalChunks(capture).map((chunk) => Buffer.from(chunk.data)));

assert.equal(capture.config.duration_seconds, 30);
assert.equal(capture.config.frame_len, 250);
assert.equal(capture.config.sample_rate, 10_000);
assert.equal(capture.config.channel_count, 4);
assert.equal(sourceBytes.length, EXPECTED_STREAM_BYTES);
assert.equal(sha256(sourceBytes), EXPECTED_STREAM_SHA256);
assert.equal(capture.analysis.logical_frame_hashes_sha256.length, EXPECTED_FRAMES);
assert.equal(capture.analysis.ch1_samples, EXPECTED_CH1_SAMPLES);
const results = [
  runReplay('original', capture, originalChunks(capture)),
  runReplay('2048-byte', capture, fixedSizeChunks(capture, 2048)),
  runReplay('8192-byte', capture, fixedSizeChunks(capture, 8192)),
  runReplay('one-chunk', capture, oneChunk(capture)),
];

console.log(JSON.stringify({ capture: capturePath, results }, null, 2));
