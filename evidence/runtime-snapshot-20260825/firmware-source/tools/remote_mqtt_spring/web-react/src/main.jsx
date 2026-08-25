import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LogOut, Play, RefreshCw, Send, ShieldCheck, Wifi } from 'lucide-react';
import { api } from './api/client.js';
import './styles.css';

const commandNames = {
  query_status: '刷新状态',
  set_wifi_mode: '切换网络模式',
  set_uart_baud: '设置串口波特率',
  set_comm_mode: '设置通信链路',
  ble_start: '启动 BLE 广播',
  display_text: '发送 OLED 文本',
};

function App() {
  const [user, setUser] = useState(null);
  const [authError, setAuthError] = useState('');
  const [devices, setDevices] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState('');
  const [log, setLog] = useState([]);

  async function loadMe() {
    try {
      const me = await api.get('/api/me');
      setUser(me);
      return me;
    } catch {
      setUser(null);
      return null;
    }
  }

  async function loadDevices(nextSelectedId = selectedId) {
    const data = await api.get('/api/devices');
    setDevices(data.devices || []);
    const firstId = nextSelectedId || data.devices?.[0]?.deviceId || '';
    setSelectedId(firstId);
    if (firstId) {
      setDetail(await api.get(`/api/devices/${encodeURIComponent(firstId)}`));
    } else {
      setDetail(null);
    }
  }

  useEffect(() => {
    loadMe().then((me) => {
      if (me) loadDevices('');
    });
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    const timer = setInterval(() => loadDevices(selectedId).catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, [user, selectedId]);

  async function login(email, password) {
    setAuthError('');
    try {
      const result = await api.post('/api/auth/login', { email, password });
      setUser(result.user);
      await loadDevices('');
    } catch (err) {
      setAuthError(err.message || '登录失败');
    }
  }

  async function logout() {
    await api.post('/api/auth/logout', {});
    setUser(null);
    setDevices([]);
    setSelectedId('');
    setDetail(null);
  }

  async function sendCommand(type, args = {}) {
    if (!selectedId || busy) return;
    setBusy(type);
    try {
      const item = await api.post(`/api/devices/${encodeURIComponent(selectedId)}/commands`, { type, args });
      setLog((prev) => [
        {
          at: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
          status: '等待确认',
          text: `${commandNames[type]} ${item.commandId}`,
          detail: `操作者 ${item.requestedBy}`,
        },
        ...prev,
      ].slice(0, 80));
      await loadDevices(selectedId);
    } catch (err) {
      setLog((prev) => [
        {
          at: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
          status: '失败',
          text: commandNames[type] || type,
          detail: err.message,
        },
        ...prev,
      ]);
    } finally {
      setBusy('');
    }
  }

  if (!user) {
    return <LoginScreen onLogin={login} error={authError} />;
  }

  return (
    <ConsoleLayout
      user={user}
      devices={devices}
      selectedId={selectedId}
      detail={detail}
      busy={busy}
      log={log}
      onSelect={async (id) => {
        setSelectedId(id);
        setDetail(await api.get(`/api/devices/${encodeURIComponent(id)}`));
      }}
      onRefresh={() => loadDevices(selectedId)}
      onLogout={logout}
      onCommand={sendCommand}
    />
  );
}

function LoginScreen({ onLogin, error }) {
  const [email, setEmail] = useState('admin@example.com');
  const [password, setPassword] = useState('ChangeMe123!');

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand-mark">
          <ShieldCheck size={22} />
        </div>
        <h1>无线调试云控制台</h1>
        <p>面向多用户、多设备的远程状态查看与配置控制。</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onLogin(email, password);
          }}
        >
          <label>
            邮箱
            <input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" />
          </label>
          <label>
            密码
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              autoComplete="current-password"
            />
          </label>
          {error ? <div className="error-line">{error}</div> : null}
          <button type="submit">
            <ShieldCheck size={17} />
            登录
          </button>
        </form>
      </section>
    </main>
  );
}

function ConsoleLayout({
  user,
  devices,
  selectedId,
  detail,
  busy,
  log,
  onSelect,
  onRefresh,
  onLogout,
  onCommand,
}) {
  const selected = useMemo(() => devices.find((item) => item.deviceId === selectedId) || detail?.device, [devices, selectedId, detail]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">生产控制台</div>
          <h1>无线调试远程管理</h1>
          <p>按用户审计远程命令，集中管理所有接入 MQTT 的 ESP32 设备。</p>
        </div>
        <div className="user-box">
          <span>{user.email}</span>
          <button className="secondary compact" onClick={onLogout}>
            <LogOut size={15} />
            退出
          </button>
        </div>
      </header>

      <section className="workspace">
        <aside className="device-list" aria-label="设备列表">
          <div className="panel-heading">
            <h2>设备</h2>
            <button className="secondary compact" onClick={onRefresh}>
              <RefreshCw size={15} />
              刷新
            </button>
          </div>
          <div className="device-items">
            {devices.length ? devices.map((device) => (
              <button
                key={device.deviceId}
                className={`device-row ${device.deviceId === selectedId ? 'active' : ''}`}
                onClick={() => onSelect(device.deviceId)}
              >
                <span className={`status-dot ${device.availability === 'online' ? 'ok' : 'bad'}`} />
                <span>
                  <strong>{device.deviceId}</strong>
                  <small>{device.netMode || '-'} · {device.staIp || device.apIp || '无 IP'}</small>
                </span>
              </button>
            )) : <div className="empty-state">暂无设备上报。ESP32 连接 MQTT 后会出现在这里。</div>}
          </div>
        </aside>

        <section className="device-main">
          <DeviceOverview device={selected} detail={detail} />
          <CommandPanel busy={busy} onCommand={onCommand} disabled={!selectedId} />
          <CommandLog log={log} />
        </section>
      </section>
    </main>
  );
}

function DeviceOverview({ device, detail }) {
  const status = detail?.status || {};
  const command = detail?.recentCommands?.[0];
  return (
    <section className="status-panel">
      <div className="panel-heading">
        <div>
          <h2>{device?.deviceId || '未选择设备'}</h2>
          <p>网络地址、链路状态、最近上报和最近命令确认。</p>
        </div>
        <span className={`badge ${device?.availability === 'online' ? 'ok' : 'bad'}`}>
          {device?.availability === 'online' ? '在线' : '离线'}
        </span>
      </div>
      <div className="metric-grid">
        <Metric label="网络模式" value={device?.netMode || '-'} />
        <Metric label="AP IP" value={device?.apIp || '-'} />
        <Metric label="STA IP" value={device?.staIp || '-'} />
        <Metric label="STA 状态" value={device?.staConnected ? '已连接' : '未连接'} />
        <Metric label="串口波特率" value={device?.uartBaud || '-'} />
        <Metric label="最近心跳" value={formatTime(device?.statusAt)} />
      </div>
      <div className="status-table">
        <Row label="固件标识" value={status.fw || '-'} />
        <Row label="通信模式" value={status.comm_mode || '-'} />
        <Row label="BLE" value={status.ble_ready ? '就绪' : '未启动'} />
        <Row label="WebSocket" value={status.wifi_ws_client ? '有客户端' : '无客户端'} />
        <Row label="最近命令" value={command ? `${command.commandId} / ${command.state}` : '-'} />
      </div>
    </section>
  );
}

function CommandPanel({ busy, onCommand, disabled }) {
  const [wifiMode, setWifiMode] = useState('apsta');
  const [baud, setBaud] = useState('2000000');
  const [commMode, setCommMode] = useState('auto');
  const [text, setText] = useState('Remote MQTT OK');

  return (
    <section className="command-panel">
      <div className="panel-heading">
        <h2>远程控制</h2>
        <p>所有命令都会记录操作者和目标设备。</p>
      </div>
      <div className="command-grid">
        <ControlBlock title="网络模式">
          <select value={wifiMode} onChange={(event) => setWifiMode(event.target.value)} disabled={disabled || !!busy}>
            <option value="ap">AP 模式</option>
            <option value="sta">STA 模式</option>
            <option value="apsta">APSTA 模式</option>
          </select>
          <button onClick={() => onCommand('set_wifi_mode', { mode: wifiMode })} disabled={disabled || !!busy}>
            <Send size={15} />应用模式
          </button>
        </ControlBlock>
        <ControlBlock title="串口参数">
          <select value={baud} onChange={(event) => setBaud(event.target.value)} disabled={disabled || !!busy}>
            <option>115200</option>
            <option>921600</option>
            <option>2000000</option>
            <option>3000000</option>
          </select>
          <button onClick={() => onCommand('set_uart_baud', { baud: Number(baud) })} disabled={disabled || !!busy}>
            <Send size={15} />应用波特率
          </button>
        </ControlBlock>
        <ControlBlock title="通信链路">
          <select value={commMode} onChange={(event) => setCommMode(event.target.value)} disabled={disabled || !!busy}>
            <option value="auto">自动选择</option>
            <option value="wifi">仅 WiFi</option>
            <option value="ble">仅 BLE</option>
          </select>
          <button onClick={() => onCommand('set_comm_mode', { mode: commMode })} disabled={disabled || !!busy}>
            <Send size={15} />应用链路
          </button>
        </ControlBlock>
        <ControlBlock title="OLED 显示">
          <input value={text} onChange={(event) => setText(event.target.value)} disabled={disabled || !!busy} />
          <button onClick={() => onCommand('display_text', { text })} disabled={disabled || !!busy}>
            <Send size={15} />发送文本
          </button>
        </ControlBlock>
      </div>
      <div className="quick-actions">
        <button onClick={() => onCommand('query_status', {})} disabled={disabled || !!busy}>
          <RefreshCw size={15} />刷新状态
        </button>
        <button className="secondary" onClick={() => onCommand('ble_start', {})} disabled={disabled || !!busy}>
          <Wifi size={15} />启动 BLE
        </button>
      </div>
      {busy ? <div className="pending-line"><Play size={14} />{commandNames[busy]} 下发中</div> : null}
    </section>
  );
}

function CommandLog({ log }) {
  return (
    <section className="log-panel">
      <div className="panel-heading">
        <h2>操作记录</h2>
        <p>当前页面会话内的下发记录；后端数据库保留完整审计。</p>
      </div>
      <div className="log-stream">
        {log.length ? log.map((item, index) => (
          <div className="log-line" key={`${item.at}-${index}`}>
            <span>{item.at}</span>
            <strong>{item.status}</strong>
            <span>{item.text} · {item.detail}</span>
          </div>
        )) : <div className="empty-state">暂无操作记录。</div>}
      </div>
    </section>
  );
}

function ControlBlock({ title, children }) {
  return (
    <div className="control-block">
      <h3>{title}</h3>
      <div className="control-fields">{children}</div>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="table-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

createRoot(document.getElementById('root')).render(<App />);
