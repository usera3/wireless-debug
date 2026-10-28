import React from 'react';
import { createRoot } from 'react-dom/client';
import { DashboardPage } from '../src/components/DashboardPage';
import { useConnectionStore } from '../src/store/connectionStore';
import { useParamStore, type ParamDef } from '../src/store/paramStore';
import { wsClient } from '../src/lib/wsClient';
import { appendCrc } from '../src/lib/crc16';

// Test host imports the actual component and stores; no production test APIs.
const host = window as any;
host.frames = []; host.sockets = [];
host.WebSocket = class {
  static OPEN = 1; static CLOSED = 3; readyState = 0;
  onopen?: () => void; onclose?: () => void; onmessage?: (event: { data: ArrayBuffer }) => void;
  constructor() { host.sockets.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  send(frame: Uint8Array) { host.frames.push({ frame: [...frame], url: useConnectionStore.getState().url, generation: wsClient.generation }); }
};
const base: ParamDef = {
  id: '010-001', regAddr: 2561, alias: 'CmdSpd', name: '速度', unit: 'rpm',
  desc: '', decimals: 0, signed: true, isFloat: false, readOnly: false,
  hidden: false, min: -1300, max: 1300, defaultVal: 0, page: 'CMD',
};
host.define = () => useParamStore.getState().loadParams([
  base, { ...base, regAddr: 2562, alias: 'CmdTorq', unit: '0.01A' },
  { ...base, regAddr: 2560, alias: 'CmdMode', min: 0, max: 2 },
], ['CMD']);
host.connect = (url = 'ws://127.0.0.1/fixture') => {
  useConnectionStore.getState().setUrl(url); useConnectionStore.getState().connect(); host.sockets.at(-1).open();
};
host.echo = (index: number) => {
  const response = appendCrc(Uint8Array.from(host.frames[index].frame.slice(0, 6)));
  host.sockets.at(-1).onmessage?.({ data: response.buffer });
};
host.switchAfterEcho = (depth: number, kind: string) => {
  host.echo(0);
  const switchContext = () => kind === 'table' ? host.define() : host.connect('ws://127.0.0.1/new-target');
  const later = (remaining: number) => remaining ? queueMicrotask(() => later(remaining - 1)) : switchContext();
  later(depth);
};
host.setup = () => { host.define(); host.connect(); useParamStore.getState().setDashboardEnabled(true); };
host.parameterAliases = () => useParamStore.getState().params.map(param => param.alias);
host.switchDuringFileLoad = () => {
  const read = FileReader.prototype.readAsArrayBuffer;
  FileReader.prototype.readAsArrayBuffer = function(file) {
    const loaded = this.onload;
    this.onload = event => { loaded?.call(this, event); host.connect(`ws://${location.host}/ws/device/new-target`); };
    read.call(this, file);
  };
};
createRoot(document.getElementById('root')!).render(<DashboardPage />);
