import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FrameRouter } from '../src/lib/frameRouter';
import { OscHistory } from '../src/lib/oscHistory';
import { OscRealtimeBuffer } from '../src/lib/oscRealtimeBuffer';
import { parseOscDataFrame } from '../src/lib/oscilloscope';

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
  const realtime = new OscRealtimeBuffer();
  const channels = Array.from({ length: capture.config.channel_count }, (_, index) => ({
    channelNo: index + 1,
    byteWidth: 2,
    paramType: 0,
  }));
  const descriptors = channels.map(({ byteWidth, paramType }) => ({ byteWidth, paramType }));
  const expectedHashes = capture.analysis.logical_frame_hashes_sha256;
  const frameHashes: string[] = [];
  const baseTimeMs = 1_000;
  let currentTimeMs = baseTimeMs;
  let parsedCh1Samples = 0;

  router.setFrameLen(capture.config.frame_len);
  history.reset(channels.map((channel) => channel.channelNo), capture.config.sample_rate, 60);
  realtime.reset(baseTimeMs);
  router.onOscFrame((frame) => {
    frameHashes.push(sha256(frame));
    const parsed = parseOscDataFrame(frame, descriptors, { requireCrc: true });
    assert(parsed, `${mode}: router emitted an invalid frame`);
    parsedCh1Samples += parsed.channels[0]?.length ?? 0;
    parsed.channels.forEach((samples, index) => {
      realtime.append(channels[index].channelNo, samples, currentTimeMs);
    });
    if (realtime.shouldFlush(currentTimeMs, 50)) {
      const drained = realtime.drain(currentTimeMs);
      if (drained) history.appendBatch(drained.batch);
    }
  });

  for (const chunk of chunks) {
    currentTimeMs = baseTimeMs + chunk.tMs;
    router.feed(chunk.data);
  }

  const finalDrain = realtime.drain(currentTimeMs);
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

  assert.equal(frameHashes.length, expectedHashes.length, `${mode}: frame count`);
  assert.deepEqual(frameHashes, expectedHashes, `${mode}: frame order/hash`);
  assert.equal(parsedCh1Samples, capture.analysis.ch1_samples, `${mode}: parsed CH1 samples`);
  assert.equal(exported.length, parsedCh1Samples, `${mode}: retained CH1 samples`);
  assert.equal(nullSamples, 0, `${mode}: address history must remain contiguous`);
  return result;
}

const capturePath = process.argv[2] ?? '/tmp/osc-c52c-local-30s.json';
const capture = JSON.parse(readFileSync(capturePath, 'utf8')) as Capture;
const results = [
  runReplay('original', capture, originalChunks(capture)),
  runReplay('2048-byte', capture, fixedSizeChunks(capture, 2048)),
  runReplay('8192-byte', capture, fixedSizeChunks(capture, 8192)),
  runReplay('one-chunk', capture, oneChunk(capture)),
];

console.log(JSON.stringify({ capture: capturePath, results }, null, 2));
