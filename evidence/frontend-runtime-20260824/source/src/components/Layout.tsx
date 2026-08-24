import type { ReactNode } from 'react';
import { useState } from 'react';
import { useConnectionStore } from '../store/connectionStore';

type Tab = 'dashboard' | 'osc' | 'modbusOsc' | 'params' | 'connection' | 'debug' | 'bootloader';

interface LayoutProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  children: ReactNode;
  variant?: 'device' | 'platform';
}

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'dashboard', label: '仪表盘', icon: '🎛️' },
  { id: 'osc', label: '地址示波器', icon: '📈' },
  { id: 'modbusOsc', label: '参数示波器', icon: '📉' },
  { id: 'params', label: '参数编辑', icon: '⚙️' },
  { id: 'bootloader', label: '固件烧录', icon: '🚀' },
  { id: 'connection', label: '连接设置', icon: '🔌' },
  { id: 'debug', label: '调试信息', icon: '🐛' },
];

export function Layout({ activeTab, onTabChange, children, variant = 'device' }: LayoutProps) {
  const connected = useConnectionStore((s) => s.connected);
  const connecting = useConnectionStore((s) => s.connecting);
  const [showDebug, setShowDebug] = useState(false);

  const visibleTabs = variant === 'platform'
    ? [{ id: 'dashboard' as Tab, label: '仪表盘', icon: 'OV' }]
    : (showDebug ? TABS : TABS.filter((t) => t.id !== 'debug'));

  return (
    <div className="flex flex-col h-screen bg-slate-900 text-slate-100">
      {/* 顶部 Header */}
      <header className="flex items-center justify-between px-4 py-2 bg-slate-800 border-b border-slate-700 shrink-0">
        <h1
          className="text-base font-bold tracking-wide text-blue-400 select-none cursor-default"
          onDoubleClick={() => setShowDebug((v) => !v)}
        >
          Wireless Debug
        </h1>
        <div className="flex items-center gap-2 text-sm">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              connected ? 'bg-green-400' : connecting ? 'bg-yellow-400 animate-pulse' : 'bg-red-500'
            }`}
          />
          <span className="text-slate-400">
            {connected ? '已连接' : connecting ? '连接中...' : '未连接'}
          </span>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* 左侧侧边栏（桌面） */}
        <nav className="hidden md:flex w-36 shrink-0 bg-slate-800 border-r border-slate-700 flex-col pt-2">
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`flex items-center gap-2 px-4 py-3 text-sm text-left transition-colors ${
                activeTab === tab.id
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-300 hover:bg-slate-700'
              }`}
            >
              <span>{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>

        {/* 内容区（手机底部留出 Tab Bar 的空间） */}
        <main className="flex-1 overflow-auto min-h-0">
          {children}
        </main>
      </div>

      {/* 底部 Tab Bar（手机） */}
      <nav className="md:hidden shrink-0 flex bg-slate-800 border-t border-slate-700">
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`flex-1 flex flex-col items-center justify-center py-2 gap-0.5 text-xs transition-colors ${
              activeTab === tab.id
                ? 'text-blue-400'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <span className="text-lg leading-none">{tab.icon}</span>
            <span className="leading-tight">{tab.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
