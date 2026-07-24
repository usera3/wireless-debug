export type AlignedSeries = number[] | (number | null)[];
export type AlignedData = [number[], ...AlignedSeries[]];

export interface OscHistoryStats {
  version: number;
  sampleRate: number;
  channelCount: number;
  firstSampleIndex: number;
  latestSampleIndex: number;
  retainedSamples: number;
  retainedSeconds: number;
  totalSamples: number;
  droppedSamples: number;
  estimatedBytes: number;
}

export interface OscHistoryExport {
  columns: (number | null)[][];
  startSampleIndex: number;
}

interface Chunk {
  start: number;
  offset: number;
  length: number;
  data: Float64Array;
}

const CHUNK_SIZE = 8192;
const DEFAULT_SAMPLE_RATE = 1000;

function emptyAlignedData(seriesCount: number): AlignedData {
  const data: AlignedData = [[]];
  for (let i = 0; i < seriesCount; i++) data.push([]);
  return data;
}

class ChannelHistory {
  private chunks: Chunk[] = [];
  private nextSampleIndex = 0;
  private dropped = 0;

  clear() {
    this.chunks = [];
    this.nextSampleIndex = 0;
    this.dropped = 0;
  }

  append(samples: number[], maxSamples: number, targetEndSample?: number) {
    const requestedEnd = Number.isFinite(targetEndSample)
      ? Math.max(this.nextSampleIndex + samples.length, Math.floor(targetEndSample as number))
      : this.nextSampleIndex + samples.length;
    let writeIndex = requestedEnd - samples.length;
    let src = 0;
    while (src < samples.length) {
      let chunk = this.chunks[this.chunks.length - 1];
      const chunkEnd = chunk ? chunk.start + chunk.length : -1;
      if (!chunk || chunk.offset + chunk.length >= chunk.data.length || chunkEnd !== writeIndex) {
        chunk = {
          start: writeIndex,
          offset: 0,
          length: 0,
          data: new Float64Array(CHUNK_SIZE),
        };
        this.chunks.push(chunk);
      }

      const writable = chunk.data.length - chunk.offset - chunk.length;
      const count = Math.min(writable, samples.length - src);
      for (let i = 0; i < count; i++) {
        chunk.data[chunk.offset + chunk.length + i] = samples[src + i];
      }
      chunk.length += count;
      src += count;
      writeIndex += count;
    }

    this.nextSampleIndex = requestedEnd;

    this.trim(maxSamples);
  }

  setRetention(maxSamples: number) {
    this.trim(maxSamples);
  }

  get firstSampleIndex(): number {
    return this.chunks[0]?.start ?? this.nextSampleIndex;
  }

  get latestSampleIndex(): number {
    return this.nextSampleIndex;
  }

  get retainedSamples(): number {
    return this.latestSampleIndex - this.firstSampleIndex;
  }

  get totalSamples(): number {
    return this.nextSampleIndex;
  }

  get droppedSamples(): number {
    return this.dropped;
  }

  forEachRange(startInclusive: number, endExclusive: number, visit: (value: number, sampleIndex: number) => void) {
    if (endExclusive <= startInclusive) return;

    for (const chunk of this.chunks) {
      const chunkEnd = chunk.start + chunk.length;
      if (chunkEnd <= startInclusive) continue;
      if (chunk.start >= endExclusive) break;

      const from = Math.max(startInclusive, chunk.start);
      const to = Math.min(endExclusive, chunkEnd);
      let pos = chunk.offset + (from - chunk.start);
      for (let sampleIndex = from; sampleIndex < to; sampleIndex++) {
        visit(chunk.data[pos++], sampleIndex);
      }
    }
  }

  rangeToArray(startInclusive: number, endExclusive: number): number[] {
    const out: number[] = [];
    this.forEachRange(startInclusive, endExclusive, (value) => out.push(value));
    return out;
  }

  rangeToAlignedArray(startInclusive: number, endExclusive: number): (number | null)[] {
    const out = Array<number | null>(Math.max(0, endExclusive - startInclusive)).fill(null);
    this.forEachRange(startInclusive, endExclusive, (value, sampleIndex) => {
      out[sampleIndex - startInclusive] = value;
    });
    return out;
  }

  minMaxRange(startInclusive: number, endExclusive: number): {
    min: number;
    max: number;
    minSampleIndex: number;
    maxSampleIndex: number;
  } | null {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let minSampleIndex = -1;
    let maxSampleIndex = -1;

    this.forEachRange(startInclusive, endExclusive, (value, sampleIndex) => {
      if (!Number.isFinite(value)) return;
      if (value < min) {
        min = value;
        minSampleIndex = sampleIndex;
      }
      if (value > max) {
        max = value;
        maxSampleIndex = sampleIndex;
      }
    });

    if (minSampleIndex < 0 || maxSampleIndex < 0) return null;
    return { min, max, minSampleIndex, maxSampleIndex };
  }

  estimatedBytes(): number {
    return this.chunks.reduce((sum, chunk) => sum + chunk.length * Float64Array.BYTES_PER_ELEMENT, 0);
  }

  private trim(maxSamples: number) {
    if (!Number.isFinite(maxSamples) || maxSamples <= 0) {
      this.dropped += this.retainedSamples;
      this.chunks = [];
      return;
    }

    const targetFirst = Math.max(0, this.nextSampleIndex - Math.floor(maxSamples));
    while (this.chunks.length > 0) {
      const chunk = this.chunks[0];
      const chunkEnd = chunk.start + chunk.length;
      if (chunkEnd <= targetFirst) {
        this.dropped += chunk.length;
        this.chunks.shift();
        continue;
      }
      if (chunk.start < targetFirst) {
        const drop = targetFirst - chunk.start;
        chunk.start += drop;
        chunk.offset += drop;
        chunk.length -= drop;
        this.dropped += drop;
      }
      break;
    }
  }
}

export class OscHistory {
  private channels = new Map<number, ChannelHistory>();
  private channelOrder: number[] = [];
  private sampleRate = DEFAULT_SAMPLE_RATE;
  private retentionSeconds = 300;
  private version = 0;

  reset(channelNos: number[], sampleRate = this.sampleRate, retentionSeconds = this.retentionSeconds) {
    this.channels.clear();
    this.channelOrder = [...channelNos].sort((a, b) => a - b);
    this.sampleRate = normalizeSampleRate(sampleRate);
    this.retentionSeconds = normalizeRetention(retentionSeconds);
    for (const chNo of this.channelOrder) {
      this.channels.set(chNo, new ChannelHistory());
    }
    this.version++;
  }

  setSampleRate(sampleRate: number) {
    this.sampleRate = normalizeSampleRate(sampleRate);
    this.applyRetention();
    this.version++;
  }

  setRetentionSeconds(seconds: number) {
    this.retentionSeconds = normalizeRetention(seconds);
    this.applyRetention();
    this.version++;
  }

  appendBatch(batch: Map<number, number[]>) {
    this.appendBatchAt(batch);
  }

  appendBatchAt(batch: Map<number, number[]>, elapsedMs?: number) {
    const maxSamples = this.maxRetainedSamples();
    const targetEndSample = Number.isFinite(elapsedMs)
      ? Math.max(0, Math.round((elapsedMs as number) * this.sampleRate / 1000))
      : undefined;
    batch.forEach((samples, chNo) => {
      let channel = this.channels.get(chNo);
      if (!channel) {
        channel = new ChannelHistory();
        this.channels.set(chNo, channel);
        this.channelOrder = Array.from(this.channels.keys()).sort((a, b) => a - b);
      }
      channel.append(samples, maxSamples, targetEndSample);
    });
    this.version++;
  }

  getStats(): OscHistoryStats {
    let first = Number.POSITIVE_INFINITY;
    let latest = 0;
    let retained = 0;
    let total = 0;
    let dropped = 0;
    let estimatedBytes = 0;

    this.channelOrder.forEach((chNo) => {
      const channel = this.channels.get(chNo);
      if (!channel) return;
      if (channel.retainedSamples > 0) {
        first = Math.min(first, channel.firstSampleIndex);
      }
      latest = Math.max(latest, channel.latestSampleIndex);
      retained = Math.max(retained, channel.retainedSamples);
      total = Math.max(total, channel.totalSamples);
      dropped = Math.max(dropped, channel.droppedSamples);
      estimatedBytes += channel.estimatedBytes();
    });

    if (!Number.isFinite(first)) first = latest;
    return {
      version: this.version,
      sampleRate: this.sampleRate,
      channelCount: this.channelOrder.length,
      firstSampleIndex: first,
      latestSampleIndex: latest,
      retainedSamples: retained,
      retainedSeconds: retained / this.sampleRate,
      totalSamples: total,
      droppedSamples: dropped,
      estimatedBytes,
    };
  }

  buildAlignedData(
    channelNos: number[],
    startSec: number,
    endSec: number,
    maxPlotPoints: number,
  ): AlignedData {
    const rate = this.sampleRate;
    const stats = this.getStats();
    if (stats.retainedSamples <= 0 || endSec <= startSec) return emptyAlignedData(channelNos.length);

    const startSample = clampSample(Math.floor(startSec * rate), stats.firstSampleIndex, stats.latestSampleIndex);
    const endSample = clampSample(Math.ceil(endSec * rate), startSample + 1, stats.latestSampleIndex);
    const sampleCount = endSample - startSample;
    if (sampleCount <= 0) return emptyAlignedData(channelNos.length);

    const maxPoints = Math.max(64, Math.floor(maxPlotPoints));
    if (sampleCount <= maxPoints) {
      return this.buildRawAlignedData(channelNos, startSample, endSample);
    }
    return this.buildMinMaxAlignedData(channelNos, startSample, endSample, maxPoints);
  }

  exportColumns(channelNos: number[]): OscHistoryExport {
    const stats = this.getStats();
    const start = stats.firstSampleIndex;
    const end = stats.latestSampleIndex;
    return {
      startSampleIndex: start,
      columns: channelNos.map((chNo) => this.channels.get(chNo)?.rangeToAlignedArray(start, end) ?? []),
    };
  }

  private buildRawAlignedData(channelNos: number[], startSample: number, endSample: number): AlignedData {
    const xData: number[] = [];
    for (let sample = startSample; sample < endSample; sample++) {
      xData.push(sample / this.sampleRate);
    }
    const series = channelNos.map((chNo) => this.channels.get(chNo)?.rangeToAlignedArray(startSample, endSample) ?? []);
    return [xData, ...series];
  }

  private buildMinMaxAlignedData(
    channelNos: number[],
    startSample: number,
    endSample: number,
    maxPlotPoints: number,
  ): AlignedData {
    const bucketSize = Math.max(1, Math.ceil((endSample - startSample) / Math.floor(maxPlotPoints / 2)));
    const xData: number[] = [];
    const series = channelNos.map(() => [] as (number | null)[]);

    for (let bucketStart = startSample; bucketStart < endSample; bucketStart += bucketSize) {
      const bucketEnd = Math.min(endSample, bucketStart + bucketSize);
      const pointOffset = xData.length;
      xData.push(bucketStart / this.sampleRate);
      if (bucketEnd - 1 !== bucketStart) {
        xData.push((bucketEnd - 1) / this.sampleRate);
      }

      channelNos.forEach((chNo, seriesIndex) => {
        const range = this.channels.get(chNo)?.minMaxRange(bucketStart, bucketEnd) ?? null;
        const out = series[seriesIndex];
        if (!range) {
          out[pointOffset] = null;
          if (bucketEnd - 1 !== bucketStart) out[pointOffset + 1] = null;
        } else {
          const minFirst = range.minSampleIndex <= range.maxSampleIndex;
          out[pointOffset] = minFirst ? range.min : range.max;
          if (bucketEnd - 1 !== bucketStart) {
            out[pointOffset + 1] = minFirst ? range.max : range.min;
          }
        }
      });
    }

    return [xData, ...series];
  }

  private applyRetention() {
    const maxSamples = this.maxRetainedSamples();
    this.channels.forEach((channel) => channel.setRetention(maxSamples));
  }

  private maxRetainedSamples(): number {
    return Math.max(1, Math.floor(this.sampleRate * this.retentionSeconds));
  }
}

function normalizeSampleRate(sampleRate: number): number {
  return Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : DEFAULT_SAMPLE_RATE;
}

function normalizeRetention(seconds: number): number {
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 300;
}

function clampSample(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export const oscHistory = new OscHistory();
