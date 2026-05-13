import type { ReactNode } from 'react';
import { useConnectionStore } from '../store/connectionStore';

type Tab = 'osc' | 'modbusOsc' | 'params' | 'connection' | 'debug';

interface LayoutProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  children: ReactNode;
}

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'osc', label: '地址示波器', icon: '📈' },
  { id: 'modbusOsc', label: '参数示波器', icon: '📉' },
  { id: 'params', label: '参数编辑', icon: '⚙️' },
  { id: 'connection', label: '连接设置', icon: '🔌' },
  { id: 'debug', label: '调试信息', icon: '🐛' },
];

export function Layout({ activeTab, onTabChange, children }: LayoutProps) {
  const connected = useConnectionStore((s) => s.connected);

  return (
    <div className="flex flex-col h-screen bg-slate-900 text-slate-100">
      {/* 顶部 Header */}
      <header className="flex items-center justify-between px-4 py-2 bg-slate-800 border-b border-slate-700 shrink-0">
        <h1 className="text-base font-bold tracking-wide text-blue-400">
          Wireless Debug
        </h1>
        <div className="flex items-center gap-2 text-sm">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              connected ? 'bg-green-400' : 'bg-red-500'
            }`}
          />
          <span className="text-slate-400">{connected ? '已连接' : '未连接'}</span>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* 左侧侧边栏 */}
        <nav className="w-36 shrink-0 bg-slate-800 border-r border-slate-700 flex flex-col pt-2">
          {TABS.map((tab) => (
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

        {/* 内容区 */}
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}