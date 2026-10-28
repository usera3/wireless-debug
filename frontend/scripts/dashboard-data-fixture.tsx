import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useDashboardPoller } from '../src/hooks/useDashboardPoller';
import { useConnectionStore } from '../src/store/connectionStore';
import { useParamStore, type ParamDef } from '../src/store/paramStore';
import { wsClient } from '../src/lib/wsClient';
import { appendCrc } from '../src/lib/crc16';

// Test-only host: the production hook and protocol pipeline are unchanged.
const host = window as any;
host.socketFrames = [];
host.fixtureSockets = [];
host.results = [];
host.dateOffset = 0;
const realNow = Date.now;
Date.now = () => realNow() + host.dateOffset;
host.WebSocket = class {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: ArrayBuffer }) => void;
  constructor() { host.fixtureSockets.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  send(data: Uint8Array) {
    if (host.throwSend) throw new Error('fixture send failure');
    host.socketFrames.push({ frame: [...data], receivedAt: Date.now(), generation: wsClient.generation });
  }
};

const definition: ParamDef = {
  id: '001-001', regAddr: 257, alias: 'CmdSpd', name: '速度', unit: 'rpm',
  desc: '', decimals: 0, signed: true, isFloat: false, readOnly: false,
  hidden: false, min: -1300, max: 1300, defaultVal: 0, page: 'CMD',
};
host.define = (overrides: Partial<ParamDef>[]) => {
  useParamStore.getState().loadParams(overrides.map((item) => ({ ...definition, ...item })), ['CMD']);
};
host.openConnection = (url = 'ws://127.0.0.1/fixture') => {
  useConnectionStore.getState().setUrl(url);
  useConnectionStore.getState().connect();
  host.fixtureSockets.at(-1).open();
};
host.disconnect = () => useConnectionStore.getState().disconnect();
host.emit = (body: number[], badCrc = false) => {
  const response = appendCrc(Uint8Array.from(body));
  if (badCrc) response[response.length - 1] ^= 1;
  host.fixtureSockets.at(-1).onmessage?.({ data: response.buffer });
};
host.read = (values: number[], badCrc = false) => host.emit(
  [255, 3, values.length * 2, ...values.flatMap(value => [(value >>> 8) & 255, value & 255])], badCrc,
);
host.echo = (frame: number[]) => host.emit(frame.slice(0, 6));
host.storeValues = () => useParamStore.getState().values;

function Fixture() {
  const [enabled, setEnabled] = useState(false);
  const data = useDashboardPoller(enabled);
  host.setEnabled = setEnabled;
  host.snapshot = () => ({ readings: data.readings ?? {}, speedHistory: data.speedHistory ?? [] });
  host.write = (alias: string, value: number) => {
    const index = host.results.length;
    host.results.push({ state: 'pending' });
    data.writeParam(alias, value).then(
      () => { host.results[index] = { state: 'resolved' }; },
      (error: Error) => { host.results[index] = { state: 'rejected', message: error.message }; },
    );
    return index;
  };
  return <div>Dashboard hook fixture</div>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
