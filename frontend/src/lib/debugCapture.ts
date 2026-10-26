/**
 * 全局调试捕获模块。
 * 在 main.tsx 中 import 一次即可，自动将 wsClient TX 和 frameRouter RX 钩入 debugStore。
 */
import { wsClient } from './wsClient';
import { frameRouter } from './frameRouter';
import { useDebugStore } from '../store/debugStore';
import { toHexString, parseTxFrame, parseRxFrame } from './frameParser';

// TX：挂在 wsClient，发送粒度本就是单条完整命令帧
wsClient.onRawSend((data) => {
  useDebugStore.getState().addEntry({
    dir: 'tx',
    ts: Date.now(),
    hex: toHexString(data),
    desc: parseTxFrame(data),
  });
});

// RX：挂在 frameRouter，每条记录都是边界已识别的完整帧
frameRouter.onRxLog((frame, type) => {
  useDebugStore.getState().addEntry({
    dir: 'rx',
    ts: Date.now(),
    hex: toHexString(frame),
    desc: type === 'osc'
      ? `示波数据帧  ${frame.length} B`
      : parseRxFrame(frame),
  });
});