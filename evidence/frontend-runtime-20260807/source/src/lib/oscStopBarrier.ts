import { buildStopOsc } from './oscilloscope';
import { waitForOscResponse } from './oscRequest';

type FrameHandler = (frame: Uint8Array) => void;

export interface OscStopBarrierOptions {
  timeoutMs: number;
  subscribe: (handler: FrameHandler) => () => void;
  send: (frame: Uint8Array) => void;
  isCurrent?: () => boolean;
}

export type OscStopBarrierResult = 'ack' | 'timeout' | 'superseded';

export async function waitForOscStopBarrier({
  timeoutMs,
  subscribe,
  send,
}: OscStopBarrierOptions): Promise<OscStopBarrierResult> {
  try {
    await waitForOscResponse({
      request: buildStopOsc(),
      timeoutMs,
      subscribe,
      send,
    });
    return 'ack';
  } catch {
    return 'timeout';
  }
}

export class OscStopBarrierSequence {
  private pendingAcks = 0;
  private tail: Promise<void> | null = null;

  wait(options: OscStopBarrierOptions): Promise<OscStopBarrierResult> {
    const operation = this.tail
      ? this.tail.then(() => this.waitForNext(options))
      : this.waitForNext(options);
    const settled = operation.then(() => undefined, () => undefined);
    this.tail = settled;
    void settled.then(() => {
      if (this.tail === settled) this.tail = null;
    });
    return operation;
  }

  private async waitForNext({
    timeoutMs,
    subscribe,
    send,
    isCurrent = () => true,
  }: OscStopBarrierOptions): Promise<OscStopBarrierResult> {
    if (!isCurrent()) return 'superseded';
    const requiredAcks = this.pendingAcks + 1;
    let receivedAcks = 0;

    try {
      await waitForOscResponse({
        request: buildStopOsc(),
        timeoutMs,
        subscribe,
        send,
        acceptResponse: () => {
          if (!isCurrent()) return false;
          receivedAcks += 1;
          return receivedAcks >= requiredAcks;
        },
      });
      this.pendingAcks = 0;
      return 'ack';
    } catch {
      if (!isCurrent()) return 'superseded';
      this.pendingAcks = Math.max(0, requiredAcks - receivedAcks);
      return 'timeout';
    }
  }
}
