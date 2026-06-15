import { useEffect, useState } from 'react';
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

type Tab = 'dashboard' | 'osc' | 'modbusOsc' | 'params' | 'connection' | 'debug' | 'bootloader';

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const { connected, connect } = useConnectionStore();
  const [toast, setToast] = useState<string | null>(null);

  // 页面加载 3s 后自动尝试连接默认地址
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!useConnectionStore.getState().connected) {
        connect();
      }
    }, 3000);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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