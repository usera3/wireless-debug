const OSC_HEADER = [0xff, 0x77, 0xaa, 0x55];

function isOscFrame(data: Uint8Array): boolean {
  return data.length >= 4 && OSC_HEADER.every((b, i) => data[i] === b);
}

function hex2(n: number) {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

/** 将 Uint8Array 转成 hex 字符串，超长时截断显示 */
export function toHexString(data: Uint8Array, maxBytes = 32): string {
  const bytes = Array.from(data.slice(0, maxBytes)).map(hex2).join(' ');
  return data.length > maxBytes ? `${bytes} … (+${data.length - maxBytes}B)` : bytes;
}

/** 解析 TX 帧（主机发出）为可读描述 */
export function parseTxFrame(data: Uint8Array): string {
  if (data.length < 2) return '(太短)';
  const fc = data[1];

  if (fc === 0x04) {
    const reg = ((data[2] ?? 0) << 8) | (data[3] ?? 0);
    const name =
      reg === 0x0000 ? '帧长' :
      reg === 0x0001 ? '最大通道数' :
      reg === 0x0002 ? '采样率' :
      `寄存器 0x${reg.toString(16).toUpperCase()}`;
    return `FC04 查询 ${name}`;
  }

  if (fc === 0x75) {
    const ch   = data[2];
    const type = data[3];
    const addr = ((data[4] ?? 0) << 8) | (data[5] ?? 0);
    return `FC75 设置通道 CH${ch}  paramType=0x${hex2(type)}  addr=0x${addr.toString(16).toUpperCase().padStart(4, '0')}`;
  }

  if (fc === 0x71) return 'FC71 开始示波';
  if (fc === 0x72) return 'FC72 停止示波';
  if (fc === 0x08) return 'FC08 心跳';
  if (fc === 0x73) {
    const bps = ((data[2] ?? 0) << 24) | ((data[3] ?? 0) << 16) | ((data[4] ?? 0) << 8) | (data[5] ?? 0);
    return `FC73 设置通信速率 ${bps} B/s`;
  }
  if (fc === 0x03) {
    const reg   = ((data[2] ?? 0) << 8) | (data[3] ?? 0);
    const count = ((data[4] ?? 0) << 8) | (data[5] ?? 0);
    return `FC03 读保持寄存器 addr=0x${reg.toString(16).toUpperCase()}  count=${count}`;
  }
  if (fc === 0x06) {
    const reg = ((data[2] ?? 0) << 8) | (data[3] ?? 0);
    const val = ((data[4] ?? 0) << 8) | (data[5] ?? 0);
    return `FC06 写单寄存器 addr=0x${reg.toString(16).toUpperCase()}  val=${val}`;
  }

  return `FC=0x${hex2(fc)} (未知指令)`;
}

/** 解析 RX 帧（设备返回）为可读描述 */
export function parseRxFrame(data: Uint8Array): string {
  if (data.length < 2) return '(太短)';

  if (isOscFrame(data)) {
    return `示波数据帧  ${data.length} B`;
  }

  const fc = data[1];

  if (fc === 0x04 && data[2] === 0x02 && data.length >= 5) {
    const val = (data[3] << 8) | data[4];
    return `FC04 响应  值=${val}`;
  }

  if (fc === 0x75) return `FC75 设置通道 ACK`;
  if (fc === 0x71) return `FC71 开始示波 ACK`;
  if (fc === 0x72) return `FC72 停止示波 ACK`;
  if (fc === 0x08) return `FC08 心跳 ACK`;
  if (fc === 0x73) return `FC73 通信速率 ACK`;

  if (fc === 0x03) {
    const byteCount = data[2] ?? 0;
    return `FC03 读寄存器响应  ${byteCount} B`;
  }
  if (fc === 0x06) {
    const reg = ((data[2] ?? 0) << 8) | (data[3] ?? 0);
    const val = ((data[4] ?? 0) << 8) | (data[5] ?? 0);
    return `FC06 写寄存器 ACK  addr=0x${reg.toString(16).toUpperCase()}  val=${val}`;
  }

  return `FC=0x${hex2(fc)} (未知响应)`;
}
