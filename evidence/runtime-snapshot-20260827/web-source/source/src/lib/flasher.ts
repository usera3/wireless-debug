/**
 * Bootloader 烧录器（浏览器版）
 * 移植自 bl_electron_gui/src/flasher.js
 * EventEmitter → 回调参数（FlasherCallbacks）
 */

import { BlModbusClient } from './blModbusClient';
import type { ParsedTargetImage } from './firmwareDocument';

export interface FlasherCallbacks {
  onLog: (msg: string, type?: 'info' | 'success' | 'error' | 'warning') => void;
  onStatus: (status: string, message: string) => void;
  onProgress: (current: number, total: number, pct: number) => void;
}

export interface FlasherOptions {
  responseTimeoutMs?: number;
}

export class Flasher {
  private client: BlModbusClient;
  private cb: FlasherCallbacks;
  private shouldStop = false;
  isFlashing = false;

  constructor(slaveId: number, callbacks: FlasherCallbacks, options: FlasherOptions = {}) {
    this.client = new BlModbusClient(slaveId, options.responseTimeoutMs);
    this.cb = callbacks;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private log(msg: string, type: FlasherCallbacks['onLog'] extends (msg: string, type?: infer T) => void ? T : never = 'info') {
    this.cb.onLog(msg, type);
  }

  private status(s: string, msg: string) {
    this.cb.onStatus(s, msg);
  }

  private progress(current: number, total: number) {
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    this.cb.onProgress(current, total, pct);
  }

  // ── Public ──────────────────────────────────────────────────────────────────

  /** 停止正在进行的烧录 */
  stop() {
    this.shouldStop = true;
    this.log('正在取消操作...', 'warning');
  }

  /**
   * 烧录已解析的固件镜像
   * @param image        ParsedTargetImage（由 FirmwareDocument.getTarget() 获取）
   * @param targetCode   协议目标码（0=CPU1, 1=CM, 2=CPU2…），来自 GuiTarget.protocolTargetCode
   * @param targetLabel  用于日志显示的名称
   * @param chunkSize    单次写入字节数，默认 64
   */
  async flashParsedImage(
    image: ParsedTargetImage,
    targetCode: number,
    targetLabel: string,
    chunkSize = 64
  ): Promise<{ success: boolean; error?: string }> {
    this.log(`开始烧录 ${targetLabel}`);
    this.status('parsing', '解析固件数据...');

    const summary = image.getSummary();
    this.log('固件数据已加载');
    this.log(`  目标: ${summary.target}`);
    this.log(`  数据块数: ${summary.blockCount}`);
    this.log(`  地址范围: 0x${summary.minAddr.toString(16)} - 0x${summary.maxAddr.toString(16)}`);
    this.log(`  总字节数: ${summary.totalBytes}`);
    if (summary.is16bitMode) this.log(`  总字数: ${summary.totalWords}`);
    this.log(`  CRC32: 0x${summary.crc32.toString(16).padStart(8, '0')}`);

    return this._flashCommon(image, targetCode, chunkSize);
  }

  // ── Quick operations ────────────────────────────────────────────────────────

  async enterBootloaderMode(): Promise<{ success: true; message: string }> {
    return this.client.enterBootloaderMode();
  }

  async jumpToApplication(): Promise<{ success: true; message: string }> {
    return this.client.jumpToApplication();
  }

  async eraseFlashRange(
    startAddr: number,
    length: number,
    targetCode = 0
  ): Promise<{ success: true; message: string; startAddr: number; length: number }> {
    await this.client.enterBootloaderMode();
    if (targetCode !== 0) await this.client.setSessionTarget(targetCode);
    return Number.isFinite(startAddr) && Number.isFinite(length)
      ? this.client.eraseFlash(startAddr, length)
      : this.client.eraseFlash();
  }

  async readSystemInfo(targetCode = 0): Promise<{
    success: true;
    bootloaderInfo: Record<string, number>;
    flashInfo: Record<string, number>;
    appInfo: Record<string, number | string>;
    isBootloaderMode: boolean;
    isAppValid: boolean;
  }> {
    if (targetCode !== 0) {
      await this.client.enterBootloaderMode();
      await this.client.setSessionTarget(targetCode);
    }

    const [blResult, flashResult, appResult] = [
      await this.client.readInputRegisters(0xf000, 5),
      await this.client.readInputRegisters(0xf100, 6),
      await this.client.readInputRegisters(0xf300, 32),
    ];

    const bl = blResult.registers;
    const fl = flashResult.registers;
    const ap = appResult.registers;

    const bootloaderInfo = {
      magic: bl[0],
      version: bl[1],
      majorVersion: (bl[1] >> 8) & 0xff,
      minorVersion: bl[1] & 0xff,
      state: bl[2],
      capability: bl[3],
      errorCode: bl[4],
    };

    const flashInfo = {
      size: (fl[0] << 16) | fl[1],
      appStart: (fl[2] << 16) | fl[3],
      appMaxSize: (fl[4] << 16) | fl[5],
    };

    const appInfo: Record<string, number | string> = {
      validFlag: ap[0],
      entryAddr: (ap[1] << 16) | ap[2],
      majorVersion: ap[3],
      minorVersion: ap[4],
      appStartAddr: (ap[5] << 16) | ap[6],
      appLength: (ap[7] << 16) | ap[8],
      crc32: (ap[9] << 16) | ap[10],
      timestamp: (ap[11] << 16) | ap[12],
      gitCommitId: (ap[13] << 16) | ap[14],
      gitTagLength: ap[15],
      gitTag: '',
    };

    const tagLen = Math.min(Number(appInfo['gitTagLength']), 32);
    let tag = '';
    for (let i = 0; i < tagLen && i < 16; i++) {
      const ch = ap[16 + i] & 0xff;
      if (ch !== 0) tag += String.fromCharCode(ch);
    }
    appInfo['gitTag'] = tag;

    return {
      success: true,
      bootloaderInfo,
      flashInfo,
      appInfo,
      isBootloaderMode: bootloaderInfo.magic === 0xbeef,
      isAppValid: appInfo['validFlag'] === 0xaa55,
    };
  }

  // ── Flash flow ───────────────────────────────────────────────────────────────

  private async _flashCommon(
    image: ParsedTargetImage,
    targetCode: number,
    chunkSize: number
  ): Promise<{ success: boolean; error?: string }> {
    this.isFlashing = true;
    this.shouldStop = false;

    try {
      // 1. 进入 Bootloader
      this.status('entering-bootloader', '进入 Bootloader 模式...');
      this.log('进入 Bootloader 模式...');
      await this.client.enterBootloaderMode();
      this.log('成功进入 Bootloader 模式');
      this._checkStop();

      // 2. 设置目标（非本地 CPU1）
      if (targetCode !== 0) {
        this.status('set-target', '设置会话目标...');
        this.log(`设置会话目标: ${targetCode}...`);
        await this.client.setSessionTarget(targetCode);
        this.log('成功设置会话目标');
        this._checkStop();
      }

      // 3. 擦除
      this.status('erasing', '擦除 Flash...');
      this.log('擦除 Flash...');
      const eraseResult = await this.client.eraseFlash();
      this.log(`成功擦除 Flash: 起始=0x${eraseResult.startAddr.toString(16)}, 长度=${eraseResult.length} 字节`);
      this._checkStop();

      // 4. 写入
      this.status('writing', '写入固件...');
      await this._writeFlash(image, chunkSize);
      this._checkStop();

      // 5. 刷新缓存
      this.status('flushing', '刷新 Flash 缓存...');
      this.log('刷新 Flash 缓存...');
      await this.client.flushFlashCache();
      this.log('成功刷新 Flash 缓存');
      this._checkStop();

      // 6. 完成 APP 写入
      this.status('completing', '完成 APP 写入...');
      this.log('完成 APP 写入...');
      const completeResult = await this.client.completeAppWrite();
      this.log(`完成 APP 写入: 状态=0x${completeResult.status.toString(16)}`);
      this._checkStop();

      // 7. 跳转
      this.status('jumping', '跳转到应用程序...');
      this.log('跳转到应用程序...');
      await this.client.jumpToApplication();
      this.log('成功跳转到应用程序');

      this.isFlashing = false;
      this.status('success', '烧录完成');
      this.log('烧录完成!', 'success');
      return { success: true };
    } catch (err) {
      const msg = (err as Error).message;
      this.log(`烧录失败: ${msg}`, 'error');
      this.status('error', `烧录失败: ${msg}`);
      this.isFlashing = false;
      return { success: false, error: msg };
    }
  }

  private _checkStop() {
    if (this.shouldStop) throw new Error('用户取消操作');
  }

  private async _writeFlash(image: ParsedTargetImage, chunkSize: number) {
    const dataBlocks = image.getDataBlocks();
    if (dataBlocks.size === 0) throw new Error('没有数据需要写入');

    const sortedAddresses = Array.from(dataBlocks.keys()).sort((a, b) => a - b);
    const totalBytes = Array.from(dataBlocks.values()).reduce((s, b) => s + b.length, 0);

    this.log('开始写入固件...');
    this.log(`  总数据量: ${totalBytes} 字节`);
    this.log(`  数据块大小: ${chunkSize} 字节`);

    let writtenBytes = 0;
    const is16bit = image.is16bitMode;

    for (const baseAddr of sortedAddresses) {
      this._checkStop();
      const data = dataBlocks.get(baseAddr)!;
      let offset = 0;

      while (offset < data.length) {
        this._checkStop();
        const chunk = data.slice(offset, offset + chunkSize);

        const currentAddr = is16bit
          ? baseAddr + offset / 2
          : baseAddr + offset;

        await this.client.writeFlash(currentAddr, chunk);
        offset += chunk.length;
        writtenBytes += chunk.length;
        this.progress(writtenBytes, totalBytes);
      }
    }

    this.log(`成功写入 ${writtenBytes} 字节`);
  }
}
