import { frameRouter } from './frameRouter';

type ModbusFrameHandler = (frame: Uint8Array) => void;
type SubscribeModbusFrame = (handler: ModbusFrameHandler) => () => void;

interface WaitForMatchingModbusFrameOptions {
  timeoutMs: number;
  matches?: (frame: Uint8Array) => boolean;
  subscribe?: SubscribeModbusFrame;
}

export function waitForMatchingModbusFrame({
  timeoutMs,
  matches = () => true,
  subscribe = frameRouter.subscribeModbusFrame.bind(frameRouter),
}: WaitForMatchingModbusFrameOptions): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      reject(new Error(`modbus timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    unsubscribe = subscribe((frame) => {
      if (settled || !matches(frame)) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(frame);
    });
  });
}
