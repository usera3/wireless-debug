# Wireless Debug Web App 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 构建一个前端 Web App，通过 WebSocket 与下位机通信，支持波形示波显示和基于 ParameterTable.xlsx 的 Modbus 参数编辑。

**Architecture:** React + TypeScript SPA，通过 WebSocket 直连串口桥（串口桥已完成，不需额外开发），所有 Modbus/示波帧编解码在前端 TypeScript 中完成；波形使用 ChartGPU（WebGL GPU加速）渲染；参数表通过 xlsx.js 在浏览器解析后建立 alias→寄存器地址映射，提供分页表格 UI 进行读写。

**Tech Stack:** React 18, TypeScript, Vite, xlsx (SheetJS, 动态加载), Tailwind CSS, Zustand（状态管理）

> **波形渲染（ChartGPU）：** ChartGPU 为新兴库，暂时跳过，Task 6 中 `OscChart.tsx` 留为占位组件，待后续集成。

**部署目标：** ESP32（16MB Flash），固件占用 ~4MB，LittleFS 剩余 ~12MB；前端产物 ~1.2MB（未压缩）/ ~320KB（gzip），空间充裕。构建时须预 gzip 所有静态文件，由 ESPAsyncWebServer 直接服务 `.gz` 文件。

---

## 地址映射规则

参数 ID 格式 `PPP-NNN`（如 `001-003`）：
- **Modbus 寄存器地址** = `PPP * 256 + NNN`（十进制），例如 `001-003` → 寄存器 `0x0103 = 259`
- `decimals` 列（H列）：实际值 = 寄存器原始值 / 10^decimals
- `signed` 列（I列）：为 1 时以有符号 16-bit 解析
- `float` 列（J列）：为 1 时两个寄存器合并为 float32（占用 2 个寄存器，功能码 0x03 读 2 个）
- `read_only` 列（C列）：为 1 时只显示，不可编辑
- `hidden` 列（B列）：为 1 时不显示

---

## 任务列表

### Task 1: 项目脚手架搭建

**Files:**
- Create: `package.json`
- Create: `vite.config.ts`
- Create: `tsconfig.json`
- Create: `tailwind.config.js`
- Create: `postcss.config.js`
- Create: `index.html`
- Create: `src/main.tsx`
- Create: `src/App.tsx`

**Step 1: 初始化 Vite + React + TypeScript 项目**

```bash
cd /home/coder/project/wireless_debug_web
npm create vite@latest . -- --template react-ts --yes
```

**Step 2: 安装依赖**

```bash
npm install xlsx zustand tailwindcss postcss autoprefixer
npm install -D @types/node
npx tailwindcss init -p
```

**Step 3: 配置 Tailwind**

编辑 `tailwind.config.js`，将 `content` 改为 `["./index.html", "./src/**/*.{ts,tsx}"]`。

在 `src/index.css` 顶部加入：
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

**Step 4: 验证项目能启动**

```bash
npm run dev
```
Expected: 浏览器打开 http://localhost:5173 显示 Vite + React 默认页面。

**Step 5: Commit**

```bash
git add -A && git commit -m "chore: init vite react-ts project with dependencies"
```

---

### Task 2: WebSocket 通信层 + Modbus 帧编解码

**Files:**
- Create: `src/lib/crc16.ts` — CRC16/Modbus 实现
- Create: `src/lib/modbus.ts` — Modbus RTU 帧编解码（0x03/0x06/0x10）
- Create: `src/lib/oscilloscope.ts` — 示波自定义帧编解码（0x71/0x72/0x75/0x04/0x08/0x73）
- Create: `src/lib/wsClient.ts` — WebSocket 客户端，收发二进制 ArrayBuffer，按帧分发

**Step 1: 实现 CRC16（`src/lib/crc16.ts`）**

```typescript
// Modbus RTU CRC16，多项式 0xA001（反转 0x8005）
export function crc16(buf: Uint8Array): number {
  let crc = 0xffff;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc; // low byte first (little-endian) matches Modbus
}

export function appendCrc(payload: Uint8Array): Uint8Array {
  const crc = crc16(payload);
  const out = new Uint8Array(payload.length + 2);
  out.set(payload);
  out[payload.length] = crc & 0xff;       // CRC low byte
  out[payload.length + 1] = (crc >> 8) & 0xff; // CRC high byte
  return out;
}

export function verifyCrc(frame: Uint8Array): boolean {
  if (frame.length < 3) return false;
  const body = frame.slice(0, -2);
  const crc = crc16(body);
  return frame[frame.length - 2] === (crc & 0xff) &&
         frame[frame.length - 1] === ((crc >> 8) & 0xff);
}
```

**Step 2: 实现 Modbus 帧构建（`src/lib/modbus.ts`）**

```typescript
import { appendCrc, verifyCrc } from './crc16';

const SLAVE = 0xff;

/** 功能码 0x03：读保持寄存器 */
export function buildReadHolding(startAddr: number, count: number): Uint8Array {
  const buf = new Uint8Array(6);
  buf[0] = SLAVE; buf[1] = 0x03;
  buf[2] = (startAddr >> 8) & 0xff; buf[3] = startAddr & 0xff;
  buf[4] = (count >> 8) & 0xff;     buf[5] = count & 0xff;
  return appendCrc(buf);
}

/** 功能码 0x06：写单个保持寄存器 */
export function buildWriteSingle(addr: number, value: number): Uint8Array {
  const buf = new Uint8Array(6);
  buf[0] = SLAVE; buf[1] = 0x06;
  buf[2] = (addr >> 8) & 0xff;  buf[3] = addr & 0xff;
  buf[4] = (value >> 8) & 0xff; buf[5] = value & 0xff;
  return appendCrc(buf);
}

/** 功能码 0x10：写多个保持寄存器 */
export function buildWriteMultiple(startAddr: number, values: number[]): Uint8Array {
  const byteCount = values.length * 2;
  const buf = new Uint8Array(7 + byteCount);
  buf[0] = SLAVE; buf[1] = 0x10;
  buf[2] = (startAddr >> 8) & 0xff; buf[3] = startAddr & 0xff;
  buf[4] = 0; buf[5] = values.length;
  buf[6] = byteCount;
  values.forEach((v, i) => {
    buf[7 + i * 2] = (v >> 8) & 0xff;
    buf[8 + i * 2] = v & 0xff;
  });
  return appendCrc(buf);
}

/** 解析 0x03 响应，返回寄存器值数组 */
export function parseReadResponse(frame: Uint8Array): number[] | null {
  if (!verifyCrc(frame) || frame[1] !== 0x03) return null;
  const byteCount = frame[2];
  const regs: number[] = [];
  for (let i = 0; i < byteCount; i += 2) {
    regs.push((frame[3 + i] << 8) | frame[4 + i]);
  }
  return regs;
}
```

**Step 3: 实现示波帧构建（`src/lib/oscilloscope.ts`）**

```typescript
import { appendCrc, crc16, verifyCrc } from './crc16';

const SLAVE = 0xff;
const OSC_FRAME_HEADER = new Uint8Array([0xff, 0x77, 0xaa, 0x55]);

/** 功能码 0x04 read-input-register 通用构建 */
function buildFC04(regAddr: number): Uint8Array {
  const buf = new Uint8Array([SLAVE, 0x04, (regAddr >> 8) & 0xff, regAddr & 0xff, 0x00, 0x01]);
  return appendCrc(buf);
}

export const buildQueryMaxChannels = () => buildFC04(0x0001);
export const buildQueryFrameLen    = () => buildFC04(0x0000);
export const buildQuerySampleRate  = () => buildFC04(0x0002);

/** 0x75 设置通道：channelNo 从 1 开始，paramType 见协议表 */
export function buildSetChannel(channelNo: number, paramType: number, varAddr: number): Uint8Array {
  const buf = new Uint8Array([SLAVE, 0x75, channelNo, paramType,
    (varAddr >> 8) & 0xff, varAddr & 0xff]);
  return appendCrc(buf);
}

export const buildStartOsc  = () => appendCrc(new Uint8Array([SLAVE, 0x71, 0,0,0,0]));
export const buildStopOsc   = () => appendCrc(new Uint8Array([SLAVE, 0x72, 0,0,0,0]));
export const buildHeartbeat = () => appendCrc(new Uint8Array([SLAVE, 0x08, 0,0,0,0]));

/** 0x73 调整采样通信速率 */
export function buildSetBaudRate(bytesPerSec: number): Uint8Array {
  const buf = new Uint8Array(6);
  buf[0] = SLAVE; buf[1] = 0x73;
  new DataView(buf.buffer).setUint32(2, bytesPerSec);
  return appendCrc(buf);
}

/** 解析 0x04 响应返回 16-bit 值 */
export function parseFC04Response(frame: Uint8Array): number | null {
  if (!verifyCrc(frame) || frame[1] !== 0x04 || frame[2] !== 0x02) return null;
  return (frame[3] << 8) | frame[4];
}

/** 解析示波数据帧，返回各通道按采样点排列的原始 16-bit 值数组 */
export interface OscFrame {
  channels: number[][];   // channels[i][sampleIndex]
  rawData: Uint8Array;
}

export function parseOscDataFrame(
  data: Uint8Array,
  channelWidths: number[]  // 每通道占字节数：2/4/8
): OscFrame | null {
  // 验证帧头帧尾
  if (data.length < 10) return null;
  const hdr = [0xff, 0x77, 0xaa, 0x55];
  for (let i = 0; i < 4; i++) {
    if (data[i] !== hdr[i] || data[data.length - 4 + i] !== hdr[i]) return null;
  }
  const dataSection = data.slice(4, data.length - 6); // 去掉头尾和CRC
  const crcBytes = data.slice(data.length - 6, data.length - 4);
  const calcCrc = crc16(dataSection);
  if (crcBytes[0] !== (calcCrc & 0xff) || crcBytes[1] !== ((calcCrc >> 8) & 0xff)) return null;

  const stridePerSample = channelWidths.reduce((a, b) => a + b, 0);
  const sampleCount = Math.floor(dataSection.length / stridePerSample);
  const channels: number[][] = channelWidths.map(() => []);
  const view = new DataView(dataSection.buffer, dataSection.byteOffset);

  for (let s = 0; s < sampleCount; s++) {
    let offset = s * stridePerSample;
    channelWidths.forEach((w, ci) => {
      const val = w === 2 ? view.getInt16(offset, false)
                : w === 4 ? view.getFloat32(offset, false)
                : view.getFloat64(offset, false);
      channels[ci].push(val);
      offset += w;
    });
  }
  return { channels, rawData: dataSection };
}
```

**Step 4: 实现 WebSocket 客户端（`src/lib/wsClient.ts`）**

```typescript
type FrameHandler = (frame: Uint8Array) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private handlers: FrameHandler[] = [];
  private buffer = new Uint8Array(0);

  connect(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = (e) => this.onData(new Uint8Array(e.data as ArrayBuffer));
  }

  disconnect() { this.ws?.close(); this.ws = null; }

  send(data: Uint8Array) { this.ws?.send(data); }

  onFrame(handler: FrameHandler) { this.handlers.push(handler); }

  private onData(chunk: Uint8Array) {
    // 追加到 buffer，分发每一个完整字节序列给所有 handler（具体分帧由上层负责）
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer); merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    this.handlers.forEach(h => h(this.buffer));
    this.buffer = new Uint8Array(0); // 交由 handler 决定消费
  }
}

export const wsClient = new WsClient();
```

**Step 5: Commit**

```bash
git add src/lib/ && git commit -m "feat: add WebSocket client and Modbus/oscilloscope frame codec"
```

---

### Task 3: 全局状态管理（Zustand Store）

**Files:**
- Create: `src/store/connectionStore.ts` — WebSocket 连接状态、连接/断开动作
- Create: `src/store/oscStore.ts` — 示波通道配置、采样率、运行状态、波形数据队列
- Create: `src/store/paramStore.ts` — 参数表数据、读写结果缓存

**Step 1: 连接状态 store（`src/store/connectionStore.ts`）**

```typescript
import { create } from 'zustand';
import { wsClient } from '../lib/wsClient';

interface ConnectionState {
  url: string;
  connected: boolean;
  setUrl: (url: string) => void;
  connect: () => void;
  disconnect: () => void;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  url: 'ws://localhost:8765',
  connected: false,
  setUrl: (url) => set({ url }),
  connect: () => {
    wsClient.connect(get().url);
    set({ connected: true });
  },
  disconnect: () => {
    wsClient.disconnect();
    set({ connected: false });
  },
}));
```

**Step 2: 示波 store（`src/store/oscStore.ts`）**

```typescript
import { create } from 'zustand';

export interface ChannelConfig {
  channelNo: number;   // 1-based
  varAddr: number;     // 变量地址
  paramType: number;   // 0x00-0x04
  label: string;
  byteWidth: number;   // 2/4/8
}

interface OscState {
  running: boolean;
  sampleRate: number;
  maxChannels: number;
  frameLen: number;
  channels: ChannelConfig[];
  waveData: Map<number, number[]>; // channelNo -> 最新 N 个点
  maxPoints: number;
  setRunning: (v: boolean) => void;
  setSampleRate: (v: number) => void;
  setMaxChannels: (v: number) => void;
  setFrameLen: (v: number) => void;
  setChannels: (v: ChannelConfig[]) => void;
  pushSamples: (channelNo: number, samples: number[]) => void;
  clearWaveData: () => void;
}

export const useOscStore = create<OscState>((set) => ({
  running: false,
  sampleRate: 6000,
  maxChannels: 12,
  frameLen: 130,
  channels: [],
  waveData: new Map(),
  maxPoints: 3000,
  setRunning: (v) => set({ running: v }),
  setSampleRate: (v) => set({ sampleRate: v }),
  setMaxChannels: (v) => set({ maxChannels: v }),
  setFrameLen: (v) => set({ frameLen: v }),
  setChannels: (v) => set({ channels: v }),
  pushSamples: (channelNo, samples) =>
    set((s) => {
      const map = new Map(s.waveData);
      const existing = map.get(channelNo) ?? [];
      const merged = [...existing, ...samples].slice(-s.maxPoints);
      map.set(channelNo, merged);
      return { waveData: map };
    }),
  clearWaveData: () => set({ waveData: new Map() }),
}));
```

**Step 3: 参数 store（`src/store/paramStore.ts`）**

```typescript
import { create } from 'zustand';

export interface ParamDef {
  id: string;        // "001-003"
  regAddr: number;   // Modbus 寄存器地址（PPP*256+NNN）
  alias: string;
  name: string;
  unit: string;
  desc: string;
  decimals: number;
  signed: boolean;
  isFloat: boolean;  // float 类型需读 2 个寄存器
  readOnly: boolean;
  hidden: boolean;
  max: number;
  min: number;
  defaultVal: number;
  page: string;      // sheet name
}

interface ParamState {
  pages: string[];
  params: ParamDef[];
  values: Record<string, number>; // alias -> 已解析值（实际值）
  loadParams: (params: ParamDef[], pages: string[]) => void;
  setValue: (alias: string, val: number) => void;
}

export const useParamStore = create<ParamState>((set) => ({
  pages: [],
  params: [],
  values: {},
  loadParams: (params, pages) => set({ params, pages }),
  setValue: (alias, val) =>
    set((s) => ({ values: { ...s.values, [alias]: val } })),
}));
```

**Step 4: Commit**

```bash
git add src/store/ && git commit -m "feat: add Zustand stores for connection, oscilloscope, and parameters"
```

---

### Task 4: Excel 参数表解析器

**Files:**
- Create: `src/lib/paramParser.ts` — 用 SheetJS 解析 ParameterTable.xlsx，返回 `ParamDef[]`

**Step 1: 实现解析器（`src/lib/paramParser.ts`）**

使用**动态 import** 加载 SheetJS，避免首屏加载 ~800KB：

```typescript
import type { ParamDef } from '../store/paramStore';

function idToRegAddr(id: string): number {
  const [page, idx] = id.split('-').map(Number);
  return page * 256 + idx;
}

function parseSheet(XLSX: typeof import('xlsx'), wb: import('xlsx').WorkBook, sheetName: string): ParamDef[] {
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, defval: null });
  const params: ParamDef[] = [];
  for (let i = 3; i < rows.length; i++) {
    const row = rows[i] as any[];
    const id = row[0];
    if (!id || id === 'Page End') break;
    if (typeof id !== 'string' || !/^\d{3}-\d{3}$/.test(id)) continue;
    params.push({
      id, regAddr: idToRegAddr(id),
      hidden: !!row[1], readOnly: !!row[2],
      decimals: Number(row[7]) || 0, signed: !!row[8], isFloat: !!row[9],
      max: Number(row[11]) ?? 65535, min: Number(row[12]) ?? 0, defaultVal: Number(row[13]) ?? 0,
      alias: String(row[14] ?? ''), name: String(row[15] ?? ''),
      unit: String(row[16] ?? ''), desc: String(row[17] ?? ''),
      page: sheetName,
    });
  }
  return params;
}

export async function parseParameterTable(file: File): Promise<{ params: ParamDef[]; pages: string[] }> {
  const XLSX = await import('xlsx');   // 动态加载，仅在用户触发时才下载
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: 'array' });
        const skipSheets = new Set(['Settings', 'BASE']);
        const pages = wb.SheetNames.filter(s => !skipSheets.has(s));
        const params = pages.flatMap(s => parseSheet(XLSX, wb, s));
        resolve({ params, pages });
      } catch (err) { reject(err); }
    };
    reader.readAsArrayBuffer(file);
  });
}
```

**Step 2: Commit**

```bash
git add src/lib/paramParser.ts && git commit -m "feat: add ParameterTable.xlsx parser with dynamic SheetJS import"
```

---

### Task 5: 布局框架与连接配置 UI

**Files:**
- Create: `src/components/Layout.tsx` — 顶部导航 + 侧边栏 + 内容区三栏布局
- Create: `src/components/ConnectionPanel.tsx` — WebSocket URL 输入、连接/断开按钮、状态指示
- Modify: `src/App.tsx` — 引入布局和路由（Tab 切换）

**Step 1: 实现布局（`src/components/Layout.tsx`）**

顶部 header 显示应用名称 + 连接状态；左侧固定侧边栏含三个 Tab（示波器 / 参数编辑 / 连接设置）；右侧内容区。使用 Tailwind 实现。

**Step 2: 实现连接面板（`src/components/ConnectionPanel.tsx`）**

```tsx
- URL 输入框（默认 ws://localhost:8765）
- 连接/断开 Toggle 按钮
- 状态徽标（绿色●已连接 / 红色●未连接）
- 显示当前连接时延（ping-pong 心跳测量，可选）
```

**Step 3: App.tsx Tab 路由**

```tsx
// 三个 Tab：'osc' | 'params' | 'connection'
// 根据 activeTab 渲染对应组件
```

**Step 4: Commit**

```bash
git add src/components/ src/App.tsx && git commit -m "feat: add layout, tab routing, and connection panel UI"
```

---

### Task 6: 示波器 UI（通道配置 + 波形图表占位）

**Files:**
- Create: `src/components/OscChannelConfig.tsx` — 通道配置表单（最多 12 通道，输入变量地址、类型）
- Create: `src/components/OscChart.tsx` — **占位组件**，ChartGPU 集成暂缓，先渲染原始数据文本/计数
- Create: `src/components/OscilloscoperPage.tsx` — 组合页面（配置 + 控制按钮 + 图表区域）
- Create: `src/hooks/useOscController.ts` — 示波控制逻辑 Hook

**Step 1: 实现示波控制 Hook（`src/hooks/useOscController.ts`）**

```typescript
// 封装以下操作序列：
// 1. buildQueryFrameLen() → 等待响应 → setFrameLen
// 2. buildQueryMaxChannels() → 等待响应 → setMaxChannels
// 3. 逐通道 buildSetChannel() → 等待响应
// 4. buildQuerySampleRate() → 等待响应 → setSampleRate
// 5. buildStartOsc() → 开始接收数据帧 → 解析 → pushSamples
// 6. 每 2s 发送 buildHeartbeat() 维持连接
// 7. buildStopOsc() 停止
```

**Step 2: OscChart 占位组件（`src/components/OscChart.tsx`）**

```tsx
// ⚠️ ChartGPU 集成暂缓，待库 API 确认后实现
// 当前版本：显示各通道最新采样值 + 累计帧数计数，
// 保留 props 接口不变，方便后续替换为真正的 GPU 波形渲染
interface OscChartProps {
  channels: Map<number, number[]>;
  sampleRate: number;
}
export function OscChart({ channels, sampleRate }: OscChartProps) {
  return (
    <div className="border rounded p-4 bg-gray-900 text-green-400 font-mono text-sm">
      <p className="text-gray-400 mb-2">⚠ 波形渲染占位（ChartGPU 待集成）</p>
      {Array.from(channels.entries()).map(([ch, data]) => (
        <div key={ch}>CH{ch}: {data.length} 点, 最新值 = {data[data.length - 1] ?? '--'}</div>
      ))}
    </div>
  );
}
```

**Step 3: 实现通道配置表单（`src/components/OscChannelConfig.tsx`）**

```tsx
// 动态行数（1~maxChannels）
// 每行：通道号 | 变量地址（hex 输入） | 数据类型选择 | 标签名称
// 提供从参数表搜索变量地址的 autocomplete（输入 alias 名称自动填充地址）
```

**Step 4: 组合页面**

```tsx
// OscilloscoperPage：
// 上半部分：通道配置表 + 「查询设备」「开始」「停止」按钮
// 下半部分：OscChart 全宽实时波形图
// 状态栏：显示采样率、帧长、运行状态
```

**Step 5: Commit**

```bash
git add src/components/Osc* src/hooks/ && git commit -m "feat: add oscilloscope channel config and real-time waveform chart"
```

---

### Task 7: 参数编辑页面

**Files:**
- Create: `src/components/ParamPage.tsx` — 分页参数列表 + 读/写操作
- Create: `src/components/ParamRow.tsx` — 单参数行（展示值、编辑输入、读/写按钮）
- Create: `src/hooks/useModbusOps.ts` — Modbus 读写操作 Hook（带请求队列/超时）

**Step 1: 实现 Modbus 操作 Hook（`src/hooks/useModbusOps.ts`）**

```typescript
// readRegister(regAddr, isFloat): Promise<number>
//   → 发 buildReadHolding，等待 0x03 响应，按 decimals 换算，更新 paramStore
// writeRegister(regAddr, rawValue, isFloat): Promise<void>
//   → float 用 buildWriteMultiple（2 寄存器），整型用 buildWriteSingle
// 内部维护一个请求队列（同一时刻只有一个 pending 请求），超时 500ms 后 reject
```

**Step 2: 实现参数行（`src/components/ParamRow.tsx`）**

```tsx
// 列：参数ID | 别名 | 名称 | 单位 | 当前值（已换算） | 编辑输入框 | 读 | 写
// 只读参数：隐藏写按钮，输入框 disabled
// 浮点/有符号参数：输入框支持负数/小数
// 写入时先乘以 10^decimals 转为原始整型再发 Modbus 帧
```

**Step 3: 实现参数页（`src/components/ParamPage.tsx`）**

```tsx
// 顶部：加载 Excel 按钮（<input type="file"> accept=".xlsx"），加载后调用 parseParameterTable
// Tab 切换各 page（MOTOR0/MOTOR1/INV/...）
// 工具栏：「全部读取」（批量读所有可见参数）、「全部写入」按钮
// 过滤：搜索框按 alias/name 过滤
// 参数列表：ParamRow 组件列表，隐藏 hidden=1 的行
```

**Step 4: Commit**

```bash
git add src/components/Param* src/hooks/useModbusOps.ts && git commit -m "feat: add parameter editor with Modbus read/write support"
```

---

### Task 8: WebSocket 响应路由（帧分发器）

**Files:**
- Modify: `src/lib/wsClient.ts` — 增加基于功能码的帧路由机制
- Create: `src/lib/frameRouter.ts` — 帧分发器，区分示波数据帧与 Modbus 响应帧

**Step 1: 实现帧路由器（`src/lib/frameRouter.ts`）**

MCU 在示波模式下收到 Modbus 请求后，会将 Modbus 响应帧**拼接在示波数据帧的尾部**一起发送。因此路由逻辑为：

```
收到数据 →
  ├─ 以 FF 77 AA 55 开头？
  │     ├─ 是：取 frameLen 字节 → 交给 OscFrameHandler 解析示波数据
  │     │       剩余字节（如有）→ 按 Modbus 帧格式解析 → 交给 pending request resolver
  │     └─ 否：整段按 Modbus 帧格式解析 → 交给 pending request resolver
  └─ 继续等待（buffer 未达到足够长度）
```

```typescript
// frameRouter.ts 关键接口
export class FrameRouter {
  private buf = new Uint8Array(0);
  private frameLen = 130;          // 默认，由 queryFrameLen 更新
  private oscHandler?: (frame: Uint8Array) => void;
  private modbusHandler?: (frame: Uint8Array) => void;

  setFrameLen(n: number) { this.frameLen = n; }
  onOscFrame(h: (f: Uint8Array) => void) { this.oscHandler = h; }
  onModbusFrame(h: (f: Uint8Array) => void) { this.modbusHandler = h; }

  feed(chunk: Uint8Array) {
    // 追加 chunk 到 buf
    // 循环尝试消费：
    //   - 若 buf 以 FF 77 AA 55 开头且 buf.length >= frameLen：
    //       取前 frameLen 字节 → oscHandler
    //       剩余字节若非空 → modbusHandler（Modbus 响应附在帧尾）
    //       buf 清空
    //   - 否则（不是示波帧头）：buf 整体 → modbusHandler，buf 清空
  }
}

export const frameRouter = new FrameRouter();
```

**Step 2: 将 frameRouter 接入 wsClient**

修改 `wsClient.ts`，在 `onData` 中调用 `frameRouter.feed(chunk)`，移除原来的 `handlers` 广播逻辑。

**Step 3: Commit**

```bash
git add src/lib/frameRouter.ts && git commit -m "feat: add frame router, handle Modbus reply appended to osc frame tail"
```

---

### Task 9: 构建优化与 ESP32 部署

**Files:**
- Modify: `vite.config.ts` — 配置 build 产物压缩与代码分割
- Create: `scripts/deploy_esp32.sh` — 构建 + gzip + 上传到 ESP32 LittleFS 的脚本

**Step 1: Vite 构建优化（`vite.config.ts`）**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // xlsx 单独分包，动态 import 时才加载
        manualChunks: { xlsx: ['xlsx'] },
      },
    },
  },
});
```

**Step 2: 预 gzip 脚本（`scripts/deploy_esp32.sh`）**

```bash
#!/bin/bash
# 构建
npm run build

# 对 dist/ 下所有文件 gzip，生成 .gz 副本
find dist -type f ! -name "*.gz" | while read f; do
  gzip -9 -k "$f"
done

echo "构建产物："
du -sh dist/
echo ""
echo "gzip 后可节省："
du -sh dist/*.gz 2>/dev/null || find dist -name "*.gz" | xargs du -sh
```

**Step 3: 产物体积验证**

```bash
npm run build
# 检查 dist/assets/ 下各 chunk 大小
# 预期：
#   index-*.js   < 200 KB（主包，不含 xlsx）
#   xlsx-*.js    < 900 KB（动态加载，仅参数页使用时才下载）
# gzip 后：
#   index-*.js.gz  < 60 KB
#   xlsx-*.js.gz   < 200 KB
```

**Step 4: ESP32 端配置提示**

- 使用 **LittleFS**（推荐，优于 SPIFFS）挂载 Web 文件目录
- `ESPAsyncWebServer` 响应时检查 `Accept-Encoding: gzip`，优先返回 `.gz` 文件：
  ```cpp
  server.serveStatic("/", LittleFS, "/www/").setDefaultFile("index.html");
  // AsyncWebServer 会自动优先匹配 index.html.gz
  ```
- WebSocket 路由：`/ws` 端点由固件单独处理，不与静态文件冲突

**Step 5: Commit**

```bash
git add vite.config.ts scripts/ && git commit -m "chore: add build optimization and ESP32 deploy script"
```

---

### Task 10: 整体集成与 UI 打磨

**Files:**
- Modify: `src/App.tsx` — 集成所有页面，处理页面切换时的资源清理
- Modify: `src/components/OscilloscoperPage.tsx` — 示波运行时禁止切换 Tab，或弹出确认
- Modify: `src/components/ParamPage.tsx` — 优化批量读取进度显示

**Step 1: 示波与参数读写并发**

示波运行时**无需互斥**，Modbus 请求照常发送，MCU 会将 Modbus 响应附在下一帧示波帧尾部返回。`useModbusOps` 中的请求队列正常工作，超时时间可适当放宽到 1000ms（因为 Modbus 响应依赖于下一帧示波帧到来的时机）。

**Step 2: 错误处理 UI**

WebSocket 断开时显示 toast 通知；Modbus 超时显示行级红色警告；CRC 校验失败记录计数。

**Step 3: 响应式布局调整**

小屏幕（< 768px）折叠侧边栏为底部 Tab Bar，波形图高度自适应。

**Step 4: 最终构建验证**

```bash
npm run build
# Expected: dist/ 目录生成，无 TypeScript 错误，bundle < 2MB
```

**Step 5: Final Commit**

```bash
git add -A && git commit -m "feat: integrate all features, polish UI and error handling"
```

---

## 关键设计决策说明

| 问题 | 决策 | 原因 |
|------|------|------|
| 帧分界 | 示波帧靠帧头 `FF 77 AA 55` + 固定长度定界；帧尾附带的 Modbus 响应独立解析 | MCU 在示波模式下将 Modbus 响应拼接在示波帧尾部 |
| Modbus 地址映射 | `id = "PPP-NNN"` → `addr = PPP×256 + NNN` | 与下位机固件参数表生成规则一致（已确认） |
| 示波时序 | 先查帧长→查最大通道→设置通道→查采样率→开始 | 协议文档 §2.1-§2.5 规定的顺序 |
| WebSocket vs 串口 | 前端只对接 WebSocket；串口桥已独立完成 | 串口桥已开发完毕，无需纳入本计划 |
| 波形渲染 | OscChart 暂为占位组件，ChartGPU 待确认 API 后集成 | ChartGPU 为新库，API 未稳定，接口已预留 |
| ESP32 部署 | Vite 分包（xlsx 独立 chunk） + 预 gzip，LittleFS 存放静态文件 | 16MB Flash 充裕（产物 ~1.2MB 未压缩，~320KB gzip），动态 import xlsx 优化首屏 |
| 示波与 Modbus 并发 | 示波运行时可正常发 Modbus 请求，MCU 将响应附在示波帧尾 | 无需互斥，只需超时放宽到 1000ms |
| 参数 float 类型 | `isFloat=true` 时读写 2 个连续寄存器（0x03 count=2 / 0x10 count=2）| 协议 §2.3 参数类型 0x03 占 2 通道 |
