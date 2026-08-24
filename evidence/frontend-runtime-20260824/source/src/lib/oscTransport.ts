import type { ConnectionTarget } from './connectionTarget';

export type OscTransportDescription = {
  mode: 'local' | 'cloud' | 'invalid';
  title: string;
  detail: string;
  tone: 'fast' | 'cloud' | 'invalid';
};

export function shouldStopOscOnDisconnect(kind: ConnectionTarget['kind']): boolean {
  return kind !== 'cloud';
}

export function describeOscTransport(target: ConnectionTarget): OscTransportDescription {
  if (target.kind === 'local') {
    return {
      mode: 'local',
      title: '局域网高速通道',
      detail: '浏览器直连当前热点中的 ESP32，波形不经过云服务器',
      tone: 'fast',
    };
  }
  if (target.kind === 'cloud') {
    return {
      mode: 'cloud',
      title: '云端高速通道',
      detail: '设备通过二进制 WebSocket 上传波形，控制与状态仍使用 MQTT',
      tone: 'cloud',
    };
  }
  return {
    mode: 'invalid',
    title: '通信地址无效',
    detail: '请先在连接设置中选择局域网设备或云端设备',
    tone: 'invalid',
  };
}
