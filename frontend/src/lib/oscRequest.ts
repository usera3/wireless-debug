import { verifyCrc } from './crc16';

type FrameHandler = (frame: Uint8Array) => void;

export interface OscResponseRequest {
  request: Uint8Array;
  timeoutMs: number;
  subscribe: (handler: FrameHandler) => () => void;
  send: (frame: Uint8Array) => void;
  acceptResponse?: (frame: Uint8Array) => boolean;
}

function requestLabel(request: Uint8Array): string {
  const functionCode = request[1];
  if (functionCode === 0x04) {
    const register = (request[2] << 8) | request[3];
    if (register === 0x0000) return '查询帧长';
    if (register === 0x0001) return '查询最大通道数';
    if (register === 0x0002) return '查询采样率';
  }
  if (functionCode === 0x75) return `配置通道 ${request[2]}`;
  if (functionCode === 0x73) return '设置通讯速率';
  return `功能码 0x${functionCode.toString(16).padStart(2, '0')}`;
}

function matchesResponse(request: Uint8Array, response: Uint8Array): boolean {
  if (request.length < 2 || response.length < 5) return false;
  if (response[0] !== request[0]) return false;

  const functionCode = request[1];
  if (response[1] === (functionCode | 0x80)) return verifyCrc(response);
  if (response[1] !== functionCode || !verifyCrc(response)) return false;

  if (functionCode === 0x04) return response.length === 7 && response[2] === 0x02;
  if (functionCode === 0x75) {
    return response.length === 8
      && response[2] === request[2]
      && response[3] === request[3]
      && response[4] === request[4]
      && response[5] === request[5];
  }
  return true;
}

export function waitForOscResponse({
  request,
  timeoutMs,
  subscribe,
  send,
  acceptResponse = () => true,
}: OscResponseRequest): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`${requestLabel(request)}响应超时`));
    }, timeoutMs);

    unsubscribe = subscribe((response) => {
      if (!matchesResponse(request, response)) return;
      if (!acceptResponse(response)) return;
      clearTimeout(timer);
      unsubscribe();
      if (response[1] === (request[1] | 0x80)) {
        reject(new Error(`${requestLabel(request)}被设备拒绝，异常码 0x${response[2].toString(16).padStart(2, '0')}`));
        return;
      }
      resolve(response);
    });

    send(request);
  });
}

export interface OscResponseRetryRequest extends OscResponseRequest {
  retries: number;
  retryDelayMs: number;
}

export async function waitForOscResponseWithRetry(
  request: OscResponseRetryRequest,
): Promise<Uint8Array> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= request.retries; attempt += 1) {
    try {
      return await waitForOscResponse(request);
    } catch (error) {
      lastError = error;
      if (attempt >= request.retries) break;
      await new Promise((resolve) => setTimeout(resolve, request.retryDelayMs));
    }
  }
  throw lastError;
}
