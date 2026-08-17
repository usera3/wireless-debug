import { strict as assert } from 'node:assert';
import { appendCrc } from '../src/lib/crc16';
import { parseReadResponse } from '../src/lib/modbus';
import { waitForMatchingModbusFrame } from '../src/lib/modbusRequest';

type Handler = (frame: Uint8Array) => void;

function readResponse(registers: number[]): Uint8Array {
  const body = new Uint8Array(3 + registers.length * 2);
  body[0] = 0xff;
  body[1] = 0x03;
  body[2] = registers.length * 2;
  registers.forEach((value, index) => {
    const register = value & 0xffff;
    body[3 + index * 2] = (register >> 8) & 0xff;
    body[4 + index * 2] = register & 0xff;
  });
  return appendCrc(body);
}

function createSource() {
  const handlers = new Set<Handler>();
  return {
    subscribe(handler: Handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    emit(frame: Uint8Array) {
      handlers.forEach((handler) => handler(frame));
    },
    handlerCount() {
      return handlers.size;
    },
  };
}

{
  const source = createSource();
  const promise = waitForMatchingModbusFrame({
    timeoutMs: 200,
    subscribe: source.subscribe,
    matches: (frame) => parseReadResponse(frame, 15, { allowBadCrc: true }) != null,
  });

  source.emit(readResponse([1]));
  source.emit(readResponse([13400, 1, 4, 39, 172, 6931, -1000, 1000, 0, -1000, 12000, 60, 60000, 803, 99]));
  const frame = await promise;
  const regs = parseReadResponse(frame, 15, { allowBadCrc: true });

  assert.equal(source.handlerCount(), 0, 'resolved waits must unsubscribe');
  assert.equal(regs?.length, 15, 'wait must ignore stale responses that do not match the current request');
}

{
  const source = createSource();
  await assert.rejects(
    waitForMatchingModbusFrame({
      timeoutMs: 10,
      subscribe: source.subscribe,
      matches: (frame) => parseReadResponse(frame, 2, { allowBadCrc: true }) != null,
    }),
    /modbus timeout/,
  );
  assert.equal(source.handlerCount(), 0, 'timed out waits must unsubscribe');
}

{
  const source = createSource();
  const controller = new AbortController();
  const promise = waitForMatchingModbusFrame({
    timeoutMs: 200,
    subscribe: source.subscribe,
    signal: controller.signal,
  });

  assert.equal(source.handlerCount(), 1, 'active waits must subscribe once');
  controller.abort();
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
  assert.equal(source.handlerCount(), 0, 'aborted waits must unsubscribe immediately');
}

console.log('modbus request regression passed');
