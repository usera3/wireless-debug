export interface OscLiveFeedOptions {
  channelNos: number[];
  sampleRate: number;
  maxBufferedSamples: number;
}

export interface OscLiveFrame {
  timestamps: number[];
  batch: Map<number, number[]>;
}

export class OscLiveFeed {
  private channelNos: number[] = [];
  private sampleRate = 1000;
  private maxBufferedSamples = 1;
  private frames: OscLiveFrame[] = [];
  private bufferedSamplesCount = 0;
  private dropped = 0;
  private enabled = true;

  reset(options: OscLiveFeedOptions) {
    this.channelNos = [...new Set(options.channelNos)].sort((a, b) => a - b);
    this.sampleRate = normalizeSampleRate(options.sampleRate);
    this.maxBufferedSamples = Math.max(1, Math.floor(options.maxBufferedSamples));
    this.frames = [];
    this.bufferedSamplesCount = 0;
    this.dropped = 0;
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) {
      this.clear();
    }
  }

  push(batch: Map<number, number[]>, receivedAtMs: number) {
    if (!this.enabled) return;
    const sampleCount = this.getIncomingSampleCount(batch);
    if (sampleCount <= 0) return;

    if (this.channelNos.length === 0) {
      this.channelNos = Array.from(batch.keys()).sort((a, b) => a - b);
    }

    const timestamps = this.buildTimestamps(receivedAtMs, sampleCount);
    const frameBatch = new Map<number, number[]>();
    for (const channelNo of this.channelNos) {
      const samples = batch.get(channelNo);
      if (!samples || samples.length === 0) continue;
      frameBatch.set(channelNo, samples.slice(0, sampleCount));
    }

    this.frames.push({ timestamps, batch: frameBatch });
    this.bufferedSamplesCount += sampleCount;
    this.trim();
  }

  drainFrame(): OscLiveFrame | null {
    const frame = this.frames.shift() ?? null;
    if (!frame) return null;
    this.bufferedSamplesCount -= frame.timestamps.length;
    return frame;
  }

  clear() {
    this.frames = [];
    this.bufferedSamplesCount = 0;
    this.dropped = 0;
  }

  get bufferedFrames(): number {
    return this.frames.length;
  }

  get bufferedSamples(): number {
    return this.bufferedSamplesCount;
  }

  get droppedSamples(): number {
    return this.dropped;
  }

  private getIncomingSampleCount(batch: Map<number, number[]>): number {
    let sampleCount = 0;
    batch.forEach((samples) => {
      sampleCount = Math.max(sampleCount, samples.length);
    });
    return sampleCount;
  }

  private buildTimestamps(receivedAtMs: number, sampleCount: number): number[] {
    const sampleIntervalMs = 1000 / this.sampleRate;
    return Array.from({ length: sampleCount }, (_, index) => {
      const offset = sampleCount - 1 - index;
      return receivedAtMs - offset * sampleIntervalMs;
    });
  }

  private trim() {
    while (this.bufferedSamplesCount > this.maxBufferedSamples && this.frames.length > 0) {
      const droppedFrame = this.frames.shift();
      if (!droppedFrame) break;
      this.bufferedSamplesCount -= droppedFrame.timestamps.length;
      this.dropped += droppedFrame.timestamps.length;
    }
  }
}

function normalizeSampleRate(sampleRate: number): number {
  return Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 1000;
}

export const oscLiveFeed = new OscLiveFeed();
