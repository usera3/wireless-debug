import { useEffect, useMemo, useState } from 'react';
import { Layout } from './components/Layout';
import { ConnectionPanel } from './components/ConnectionPanel';
import { OscilloscoperPage } from './components/OscilloscoperPage';
import { ParamPage } from './components/ParamPage';
import { DebugPage } from './components/DebugPage';
import { ModbusOscPage } from './components/ModbusOscPage';
import { DashboardPage } from './components/DashboardPage';
import { BootloaderPage } from './components/BootloaderPage';
import { useConnectionStore } from './store/connectionStore';
import { wsClient } from './lib/wsClient';
import { resolveConnectionTarget } from './lib/connectionTarget';
import { requiresLocalNetworkPermission } from './lib/localNetworkAccess';
import { currentRuntimeInfo } from './lib/runtimeMode';
import { CloudPlatformPage } from './components/CloudPlatformPage';

type Tab = 'dashboard' | 'osc' | 'modbusOsc' | 'params' | 'connection' | 'debug' | 'bootloader';

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const { connected, connect } = useConnectionStore();
  const [toast, setToast] = useState<string | null>(null);
  const runtime = useMemo(() => currentRuntimeInfo(), []);

  // 页面加载 3s 后自动尝试连接默认地址
  useEffect(() => {
    if (runtime.mode === 'cloud-platform') return undefined;
    const timer = setTimeout(() => {
      const state = useConnectionStore.getState();
      const target = resolveConnectionTarget(state.url, window.location.origin);
      if (!state.connected && !requiresLocalNetworkPermission(target, window.location.protocol)) {
        connect();
      }
    }, 3000);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime.mode]);

  // 监听 WebSocket 意外断开（状态已由 wsClient.onClose 自动更新，此处仅弹 toast）
  useEffect(() => {
    function checkDisconnect() {
      if (connected && wsClient.readyState !== WebSocket.OPEN) {
        setToast('WebSocket 连接已断开');
        setTimeout(() => setToast(null), 3000);
      }
    }
    const timer = setInterval(checkDisconnect, 2000);
    return () => clearInterval(timer);
  }, [connected]);

  const content = {
    dashboard: <DashboardPage />,
    osc: <OscilloscoperPage />,
    modbusOsc: <ModbusOscPage />,
    params: <ParamPage />,
    connection: <ConnectionPanel />,
    debug: <DebugPage />,
    bootloader: <BootloaderPage />,
  }[activeTab];

  if (runtime.mode === 'cloud-platform') {
    return <CloudPlatformPage />;
  }

  return (
    <Layout activeTab={activeTab} onTabChange={setActiveTab}>
      {content}
      {/* Toast 通知 */}
      {toast && (
        <div className="fixed bottom-4 right-4 bg-red-700 text-white px-4 py-2 rounded shadow-lg text-sm z-50">
          {toast}
        </div>
      )}
    </Layout>
  );
}
