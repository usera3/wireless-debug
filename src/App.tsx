import { useState } from 'react';
import { Layout } from './components/Layout';
import { ConnectionPanel } from './components/ConnectionPanel';
import { OscilloscoperPage } from './components/OscilloscoperPage';

type Tab = 'osc' | 'params' | 'connection';

// ParamPage implemented in Task 7
function ParamPage() {
  return <div className="p-6 text-slate-400">参数编辑（Task 7 实现）</div>;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('osc');

  const content = {
    osc: <OscilloscoperPage />,
    params: <ParamPage />,
    connection: <ConnectionPanel />,
  }[activeTab];

  return (
    <Layout activeTab={activeTab} onTabChange={setActiveTab}>
      {content}
    </Layout>
  );
}