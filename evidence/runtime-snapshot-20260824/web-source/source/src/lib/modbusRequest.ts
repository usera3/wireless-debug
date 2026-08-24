import { frameRouter } from './frameRouter';

type ModbusFrameHandler = (frame: Uint8Array) => void;
type SubscribeModbusFrame = (handler: ModbusFrameHandler) => () => void;

interface WaitForMatchingModbusFrameOptions {
  timeoutMs: number;
  matches?: (frame: Uint8Array) => boolean;
  subscribe?: SubscribeModbusFrame;
  signal?: AbortSignal;
}

export function waitForMatchingModbusFrame({
  timeoutMs,
  matches = () => true,
  subscribe = frameRouter.subscribeModbusFrame.bind(frameRouter),
  signal,
}: WaitForMatchingModbusFrameOptions): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};

    const cleanup = () => {
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => rejectOnce(new DOMException('Modbus wait aborted', 'AbortError'));
    const timer = setTimeout(() => {
      rejectOnce(new Error(`modbus timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    unsubscribe = subscribe((frame) => {
      if (settled || !matches(frame)) return;
      settled = true;
      cleanup();
      resolve(frame);
    });

    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}
