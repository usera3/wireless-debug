import { useEffect, useState } from 'react';
import { Layout } from './components/Layout';
import { ConnectionPanel } from './components/ConnectionPanel';
import { OscilloscoperPage } from './components/OscilloscoperPage';
import { ParamPage } from './components/ParamPage';
import { DebugPage } from './components/DebugPage';
import { useConnectionStore } from './store/connectionStore';
import { wsClient } from './lib/wsClient';

type Tab = 'osc' | 'params' | 'connection' | 'debug';

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('osc');
  const { connected, disconnect } = useConnectionStore();
  const [toast, setToast] = useState<string | null>(null);

  // 监听 WebSocket 意外断开
  useEffect(() => {
    function checkDisconnect() {
      if (connected && wsClient.readyState !== WebSocket.OPEN) {
        disconnect();
        setToast('WebSocket 连接已断开');
        setTimeout(() => setToast(null), 3000);
      }
    }
    const timer = setInterval(checkDisconnect, 2000);
    return () => clearInterval(timer);
  }, [connected, disconnect]);

  const content = {
    osc: <OscilloscoperPage />,
    params: <ParamPage />,
    connection: <ConnectionPanel />,
    debug: <DebugPage />,
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
