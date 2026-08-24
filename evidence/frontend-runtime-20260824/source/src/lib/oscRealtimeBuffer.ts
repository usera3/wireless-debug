export interface OscRealtimeBatch {
  batch: Map<number, number[]>;
  elapsedMs: number;
}

export class OscRealtimeBuffer {
  private batch = new Map<number, number[]>();
  private startedAt = 0;
  private lastFlushAt = 0;

  reset(startedAt: number) {
    this.batch = new Map();
    this.startedAt = startedAt;
    this.lastFlushAt = startedAt;
  }

  append(channelNo: number, samples: number[], receivedAt: number) {
    if (samples.length === 0) return;
    const existing = this.batch.get(channelNo) ?? [];
    existing.push(...samples);
    this.batch.set(channelNo, existing);
    if (this.startedAt === 0) this.reset(receivedAt);
  }

  shouldFlush(receivedAt: number, intervalMs: number): boolean {
    return this.batch.size > 0 && receivedAt - this.lastFlushAt >= intervalMs;
  }

  drain(receivedAt: number): OscRealtimeBatch | null {
    if (this.batch.size === 0) return null;
    const drained = this.batch;
    this.batch = new Map();
    this.lastFlushAt = receivedAt;
    return {
      batch: drained,
      elapsedMs: Math.max(0, receivedAt - this.startedAt),
    };
  }

  clear() {
    this.batch = new Map();
    this.startedAt = 0;
    this.lastFlushAt = 0;
  }
}
