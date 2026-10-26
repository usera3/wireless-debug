import type { ReactNode } from 'react';
import { useState } from 'react';
import { useConnectionStore } from '../store/connectionStore';
import { currentRuntimeInfo } from '../lib/runtimeMode';
import { ConsoleIcon } from './ConsoleIcon';

export type Tab = 'devices' | 'dashboard' | 'osc' | 'modbusOsc' | 'params' | 'connection' | 'debug' | 'bootloader';

interface LayoutProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  children: ReactNode;
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'devices', label: '设备列表' },
  { id: 'dashboard', label: '仪表盘' },
  { id: 'osc', label: '地址示波器' },
  { id: 'modbusOsc', label: '参数示波器' },
  { id: 'params', label: '参数编辑' },
  { id: 'bootloader', label: '固件烧录' },
  { id: 'connection', label: '连接设置' },
  { id: 'debug', label: '调试信息' },
];

export function Layout({ activeTab, onTabChange, children }: LayoutProps) {
  const connected = useConnectionStore((s) => s.connected);
  const connecting = useConnectionStore((s) => s.connecting);
  const [showDebug, setShowDebug] = useState(false);
  const runtime = currentRuntimeInfo();
  const cloud = runtime.mode !== 'local-device';
  const needsDevice = runtime.mode === 'cloud-platform';
  const visibleTabs = TABS.filter(t => (cloud || t.id !== 'devices') && (showDebug || t.id !== 'debug'));
  const title = TABS.find(t => t.id === activeTab)?.label || '仪表盘';
  const status = connected ? '已连接' : connecting ? '连接中…' : '未连接';
  const workspace = cloud ? '云端设备' : '设备调试台';

  return (
    <div className="wd-device">
      <aside className="wd-sidebar">
        <div className="wd-brand" onDoubleClick={() => setShowDebug(v => !v)}>
          <span className="wd-brand-mark">GMCC<span>′</span></span>
          <span className="wd-brand-name">设备调试台</span>
        </div>
        <span className="wd-nav-caption">工作空间</span>
        <nav className="wd-nav" aria-label="设备导航">
          {visibleTabs.map(tab => (
            <button key={tab.id} type="button" onClick={() => onTabChange(tab.id)}
              disabled={needsDevice && tab.id !== 'devices'} aria-label={tab.label}
              className="wd-nav-item" aria-current={activeTab === tab.id ? 'page' : undefined} title={tab.label}>
              <ConsoleIcon name={tab.id} /><span>{tab.label}</span>
            </button>
          ))}
        </nav>
        <div className="wd-sidebar-footer">GMCC CONSOLE</div>
      </aside>
      <div className="wd-workspace">
        <header className="wd-topbar">
          <div className="wd-breadcrumb"><span>{workspace}</span><span aria-hidden="true">›</span><strong>{title}</strong></div>
          <div className="wd-topbar-actions">
            {runtime.deviceId && <span className="wd-selected-device" title={runtime.deviceId}>{runtime.deviceId}</span>}
            {!needsDevice && <div className="wd-connection" role="status">
              <i data-state={connected ? 'connected' : connecting ? 'connecting' : 'disconnected'} />{status}
            </div>}
            {cloud && <a className="wd-logout" href="/logout">退出登录</a>}
          </div>
        </header>
        <main className="wd-main">
          <section className={`wd-page wd-page--${activeTab}`}>
            <div className="wd-page-heading">
              <div><span className="wd-eyebrow">{workspace}</span><h1>{title}</h1></div>
              <div className="wd-heading-mark" aria-hidden="true">GMCC</div>
            </div>
            <div className="wd-page-content">{children}</div>
          </section>
        </main>
      </div>
    </div>
  );
}
