/**
 * 全局调试捕获模块。
 * 在 main.tsx 中 import 一次即可，自动将 wsClient 的 TX/RX 钩入 debugStore。
 */
import { wsClient } from './wsClient';
import { useDebugStore } from '../store/debugStore';
import { toHexString, parseTxFrame, parseRxFrame } from './frameParser';

wsClient.onRawSend((data) => {
  useDebugStore.getState().addEntry({
    dir: 'tx',
    ts: Date.now(),
    hex: toHexString(data),
    desc: parseTxFrame(data),
  });
});

wsClient.onRawReceive((data) => {
  useDebugStore.getState().addEntry({
    dir: 'rx',
    ts: Date.now(),
    hex: toHexString(data),
    desc: parseRxFrame(data),
  });
});
