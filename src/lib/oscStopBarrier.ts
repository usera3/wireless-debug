import { buildStopOsc } from './oscilloscope';
import { waitForOscResponse } from './oscRequest';

type FrameHandler = (frame: Uint8Array) => void;

export interface OscStopBarrierOptions {
  timeoutMs: number;
  subscribe: (handler: FrameHandler) => () => void;
  send: (frame: Uint8Array) => void;
}

export type OscStopBarrierResult = 'ack' | 'timeout';

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

export async function waitForSequencedOscStopBarrier(
  priorStop: Promise<OscStopBarrierResult> | null,
  options: OscStopBarrierOptions,
): Promise<OscStopBarrierResult> {
  if (priorStop) await priorStop;
  return waitForOscStopBarrier(options);
}
