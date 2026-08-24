export interface OscJitterBufferOptions {
  channelNos: number[];
  sampleRate: number;
  targetLatencyMs: number;
  resumeLatencyMs: number;
  tickMs: number;
  nowMs?: number;
}

export interface OscJitterDrain {
  batch: Map<number, number[]>;
  bufferedSamples: number;
}

class IndexedSampleQueue {
  private values: number[] = [];
  private offset = 0;

  append(samples: number[], count: number) {
    for (let index = 0; index < count; index++) {
      this.values.push(index < samples.length ? samples[index] : Number.NaN);
    }
  }

  take(count: number): number[] {
    const takeCount = Math.min(Math.max(0, Math.floor(count)), this.length);
    if (takeCount === 0) return [];
    const result = this.values.slice(this.offset, this.offset + takeCount);
    this.offset += takeCount;
    if (this.offset >= 4096 && this.offset * 2 >= this.values.length) {
      this.values = this.values.slice(this.offset);
      this.offset = 0;
    }
    return result;
  }

  clear() {
    this.values = [];
    this.offset = 0;
  }

  get length(): number {
    return this.values.length - this.offset;
  }
}

export class OscJitterBuffer {
  private channelNos: number[] = [];
  private queues = new Map<number, IndexedSampleQueue>();
  private sampleRate = 1000;
  private targetSamples = 300;
  private resumeSamples = 100;
  private tickMs = 50;
  private lastDrainAtMs = 0;
  private fractionalSamples = 0;
  private playing = false;
  private hasStarted = false;

  reset(options: OscJitterBufferOptions) {
    this.channelNos = [...new Set(options.channelNos)].sort((left, right) => left - right);
    this.sampleRate = normalizePositive(options.sampleRate, 1000);
    this.tickMs = normalizePositive(options.tickMs, 50);
    this.targetSamples = Math.max(
      1,
      Math.ceil(this.sampleRate * normalizePositive(options.targetLatencyMs, 300) / 1000),
    );
    this.resumeSamples = Math.min(
      this.targetSamples,
      Math.max(1, Math.ceil(this.sampleRate * normalizePositive(options.resumeLatencyMs, 100) / 1000)),
    );
    this.queues = new Map(this.channelNos.map((channelNo) => [channelNo, new IndexedSampleQueue()]));
    this.lastDrainAtMs = normalizeNow(options.nowMs);
    this.fractionalSamples = 0;
    this.playing = false;
    this.hasStarted = false;
  }

  appendBatch(batch: Map<number, number[]>) {
    let sampleCount = 0;
    batch.forEach((samples) => {
      sampleCount = Math.max(sampleCount, samples.length);
    });
    if (sampleCount <= 0) return;

    if (this.channelNos.length === 0) {
      this.channelNos = Array.from(batch.keys()).sort((left, right) => left - right);
      this.queues = new Map(this.channelNos.map((channelNo) => [channelNo, new IndexedSampleQueue()]));
    }

    for (const channelNo of this.channelNos) {
      let queue = this.queues.get(channelNo);
      if (!queue) {
        queue = new IndexedSampleQueue();
        this.queues.set(channelNo, queue);
      }
      queue.append(batch.get(channelNo) ?? [], sampleCount);
    }
  }

  drainDue(nowMs: number): OscJitterDrain | null {
    const now = normalizeNow(nowMs);
    const available = this.bufferedSamples;
    if (available <= 0) {
      this.playing = false;
      this.fractionalSamples = 0;
      this.lastDrainAtMs = now;
      return null;
    }

    if (!this.playing) {
      const startThreshold = this.hasStarted ? this.resumeSamples : this.targetSamples;
      if (available < startThreshold) {
        this.lastDrainAtMs = now;
        return null;
      }
      this.playing = true;
      this.hasStarted = true;
      this.lastDrainAtMs = now - this.tickMs;
    }

    const elapsedMs = Math.min(this.tickMs * 2, Math.max(0, now - this.lastDrainAtMs));
    this.lastDrainAtMs = now;
    const occupancyError = (available - this.targetSamples) / this.targetSamples;
    const rateScale = 1 + clamp(occupancyError * 0.05, -0.02, 0.02);
    const exactSamples = elapsedMs * this.sampleRate / 1000 * rateScale + this.fractionalSamples;
    let drainCount = Math.floor(exactSamples);
    this.fractionalSamples = exactSamples - drainCount;
    if (drainCount <= 0) return null;

    drainCount = Math.min(drainCount, available);
    const batch = this.take(drainCount);
    if (this.bufferedSamples <= 0) {
      this.playing = false;
      this.fractionalSamples = 0;
    }
    return { batch, bufferedSamples: this.bufferedSamples };
  }

  drainAll(): OscJitterDrain | null {
    const available = this.bufferedSamples;
    if (available <= 0) return null;
    const batch = this.take(available);
    this.playing = false;
    this.fractionalSamples = 0;
    return { batch, bufferedSamples: this.bufferedSamples };
  }

  clear() {
    this.queues.forEach((queue) => queue.clear());
    this.channelNos = [];
    this.queues = new Map();
    this.lastDrainAtMs = 0;
    this.fractionalSamples = 0;
    this.playing = false;
    this.hasStarted = false;
  }

  get bufferedSamples(): number {
    if (this.channelNos.length === 0) return 0;
    return this.channelNos.reduce((minimum, channelNo) => {
      const length = this.queues.get(channelNo)?.length ?? 0;
      return Math.min(minimum, length);
    }, Number.POSITIVE_INFINITY);
  }

  private take(count: number): Map<number, number[]> {
    return new Map(this.channelNos.map((channelNo) => [
      channelNo,
      this.queues.get(channelNo)?.take(count) ?? [],
    ]));
  }
}

function normalizePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeNow(value?: number): number {
  return Number.isFinite(value) ? value as number : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
