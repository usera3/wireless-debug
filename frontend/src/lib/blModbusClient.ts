/**
 * Bootloader Modbus 客户端（浏览器版）
 * 移植自 bl_electron_gui/src/modbus-client.js
 * 串口操作 → wsClient.send() + frameRouter.onModbusFrame()
 */

import { wsClient } from './wsClient';
import { frameRouter } from './frameRouter';
import { appendCrc, verifyCrc } from './crc16';
import type { ConnectionTarget } from './connectionTarget';

const LOCAL_BOOTLOADER_RESPONSE_TIMEOUT_MS = 500;
const CLOUD_BOOTLOADER_RESPONSE_TIMEOUT_MS = 5000;

export function bootloaderResponseTimeoutMs(kind: ConnectionTarget['kind']): number {
  return kind === 'cloud'
    ? CLOUD_BOOTLOADER_RESPONSE_TIMEOUT_MS
    : LOCAL_BOOTLOADER_RESPONSE_TIMEOUT_MS;
}

/** Bootloader 广播地址（进入BL时固定使用，无需知道从站ID） */
const BL_ENTER_SLAVE_ID = 0xff;

/** 各功能码响应的固定长度（不含动态 0x04） */
const RESPONSE_LEN: Record<number, number> = {
  0x65: 5,  // enterBootloaderMode
  0x66: 13, // eraseFlash
  0x67: 7,  // writeFlash
  0x68: 5,  // flushFlashCache
  0x69: 5,  // jumpToApplication
  0x6a: 5,  // completeAppWrite
  0x70: 5,  // setSessionTarget
  0x75: 5,  // resetDevice
};

const noop = (_unused: Uint8Array) => { void _unused; };

export class BlModbusClient {
  constructor(
    public slaveId: number = 1,
    private readonly responseTimeoutMs: number = LOCAL_BOOTLOADER_RESPONSE_TIMEOUT_MS,
  ) {}

  // ── Private ────────────────────────────────────────────────────────────────

  private _buildRequest(functionCode: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    const header = new Uint8Array([this.slaveId, functionCode]);
    const body = new Uint8Array(header.length + payload.length);
    body.set(header);
    body.set(payload, header.length);
    return appendCrc(body);
  }

  private async _sendRequest(data: Uint8Array, functionCode: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      let buf = new Uint8Array(0);
      let expectedLength = RESPONSE_LEN[functionCode] ?? 5;

      const timeout = setTimeout(() => {
        frameRouter.onModbusFrame(noop);
        reject(new Error('响应超时'));
      }, this.responseTimeoutMs);

      frameRouter.onModbusFrame((frame: Uint8Array) => {
        const merged = new Uint8Array(buf.length + frame.length);
        merged.set(buf);
        merged.set(frame, buf.length);
        buf = merged;

        // 0x04 读寄存器：响应长度动态
        if (functionCode === 0x04 && buf.length >= 3) {
          const byteCount = buf[2];
          expectedLength = 3 + byteCount + 2;
        }

        if (buf.length >= expectedLength) {
          clearTimeout(timeout);
          frameRouter.onModbusFrame(noop);
          resolve(buf.slice(0, expectedLength));
        }
      });

      wsClient.send(data);
    });
  }

  private _checkResponse(response: Uint8Array, expectedFc: number): Uint8Array {
    if (response.length < 4) throw new Error(`响应长度不足: ${response.length}`);

    const slaveId = response[0];
    const fc = response[1];

    if (slaveId !== this.slaveId) {
      throw new Error(`从站地址不匹配: 期望 ${this.slaveId}, 收到 ${slaveId}`);
    }

    if (fc !== expectedFc) {
      if (fc === (expectedFc | 0x80)) {
        const exc = response[2];
        throw new Error(`功能码 0x${expectedFc.toString(16)} 执行失败，异常码: 0x${exc.toString(16)}`);
      }
      throw new Error(`功能码不匹配: 期望 0x${expectedFc.toString(16)}, 收到 0x${fc.toString(16)}`);
    }

    if (!verifyCrc(response)) {
      throw new Error('CRC 校验失败');
    }

    return response.slice(2, -2);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** 进入 Bootloader 模式 (0x65)，使用固定广播地址 0xFF */
  async enterBootloaderMode(): Promise<{ success: true; message: string }> {
    const header = new Uint8Array([BL_ENTER_SLAVE_ID, 0x65]);
    const req = appendCrc(header);
    let resp: Uint8Array;
    try {
      resp = await this._sendRequest(req, 0x65);
    } catch (error) {
      // The application may switch to Bootloader before it can send the first
      // ACK. Repeating this idempotent transition command mirrors the required
      // second click while preserving real protocol and CRC failures.
      if (!(error instanceof Error) || error.message !== '响应超时') throw error;
      resp = await this._sendRequest(req, 0x65);
    }
    const data = this._checkResponse(resp, 0x65);
    if (data.length < 1) throw new Error('响应数据长度不足');
    const status = data[0];
    if (status !== 0x00) throw new Error(`进入 Bootloader 模式失败，状态码: 0x${status.toString(16)}`);
    return { success: true, message: '成功进入 Bootloader 模式' };
  }

  /** 设置会话目标 (0x70)，targetType: 0x00=本地, 0x01=CM, 0x02=CPU2 */
  async setSessionTarget(targetType: number): Promise<{ success: true; message: string }> {
    const req = this._buildRequest(0x70, new Uint8Array([targetType]));
    const resp = await this._sendRequest(req, 0x70);
    const data = this._checkResponse(resp, 0x70);
    if (data.length < 1) throw new Error('响应数据长度不足');
    const status = data[0];
    if (status !== 0x00) throw new Error(`设置会话目标失败，状态码: 0x${status.toString(16)}`);
    return { success: true, message: `成功设置会话目标: ${targetType}` };
  }

  /** 擦除 Flash (0x66) */
  async eraseFlash(
    startAddr = 0xffffffff,
    length = 0xffffffff
  ): Promise<{ success: true; message: string; startAddr: number; length: number }> {
    const payload = new Uint8Array(8);
    const view = new DataView(payload.buffer);
    view.setUint32(0, startAddr, false);
    view.setUint32(4, length, false);

    const req = this._buildRequest(0x66, payload);
    const resp = await this._sendRequest(req, 0x66);
    const data = this._checkResponse(resp, 0x66);
    if (data.length < 9) throw new Error('响应数据长度不足');
    const status = data[0];
    if (status !== 0x00) throw new Error(`擦除 Flash 失败，状态码: 0x${status.toString(16)}`);

    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return {
      success: true,
      message: '成功擦除 Flash',
      startAddr: dv.getUint32(1, false),
      length: dv.getUint32(5, false),
    };
  }

  /** 写入 Flash (0x67) */
  async writeFlash(addr: number, chunk: Uint8Array): Promise<{ success: true; writtenBytes: number }> {
    const payload = new Uint8Array(6 + chunk.length);
    const view = new DataView(payload.buffer);
    view.setUint32(0, addr, false);
    view.setUint16(4, chunk.length, false);
    payload.set(chunk, 6);

    const req = this._buildRequest(0x67, payload);
    const resp = await this._sendRequest(req, 0x67);
    const data = this._checkResponse(resp, 0x67);
    if (data.length < 3) throw new Error('响应数据长度不足');
    const status = data[0];
    if (status !== 0x00) throw new Error(`写入 Flash 失败，状态码: 0x${status.toString(16)}`);
    const dv2 = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return { success: true, writtenBytes: dv2.getUint16(1, false) };
  }

  /** 刷新 Flash 缓存 (0x68) */
  async flushFlashCache(): Promise<{ success: true; message: string }> {
    const req = this._buildRequest(0x68);
    const resp = await this._sendRequest(req, 0x68);
    const data = this._checkResponse(resp, 0x68);
    if (data.length < 1) throw new Error('响应数据长度不足');
    const status = data[0];
    if (status !== 0x00) throw new Error(`刷新 Flash 缓存失败，状态码: 0x${status.toString(16)}`);
    return { success: true, message: '成功刷新 Flash 缓存' };
  }

  /** 完成 APP 写入 (0x6A) */
  async completeAppWrite(): Promise<{ success: true; message: string; status: number }> {
    const req = this._buildRequest(0x6a);
    const resp = await this._sendRequest(req, 0x6a);
    const data = this._checkResponse(resp, 0x6a);
    if (data.length < 1) throw new Error('响应数据长度不足');
    const status = data[0];
    if (status !== 0x00 && status !== 0x06) {
      throw new Error(`完成 APP 写入失败，状态码: 0x${status.toString(16)}`);
    }
    return { success: true, message: '成功完成 APP 写入', status };
  }

  /** 跳转到应用程序 (0x69) */
  async jumpToApplication(addr = 0xffffffff): Promise<{ success: true; message: string }> {
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setUint32(0, addr, false);
    const req = this._buildRequest(0x69, payload);
    const resp = await this._sendRequest(req, 0x69);
    const data = this._checkResponse(resp, 0x69);
    if (data.length < 1) throw new Error('响应数据长度不足');
    const status = data[0];
    if (status !== 0x00) throw new Error(`跳转失败，状态码: 0x${status.toString(16)}`);
    return { success: true, message: '成功跳转到应用程序' };
  }

  /** 读取输入寄存器 (0x04) */
  async readInputRegisters(
    startAddr: number,
    count: number
  ): Promise<{ success: true; registers: number[] }> {
    const payload = new Uint8Array(4);
    const view = new DataView(payload.buffer);
    view.setUint16(0, startAddr, false);
    view.setUint16(2, count, false);

    const req = this._buildRequest(0x04, payload);
    const resp = await this._sendRequest(req, 0x04);
    const data = this._checkResponse(resp, 0x04);
    if (data.length < 1) throw new Error('响应数据长度不足');

    const byteCount = data[0];
    if (data.length < 1 + byteCount) throw new Error('响应数据长度不足');

    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const registers: number[] = [];
    for (let i = 0; i < byteCount; i += 2) {
      registers.push(dv.getUint16(1 + i, false));
    }
    return { success: true, registers };
  }
}
