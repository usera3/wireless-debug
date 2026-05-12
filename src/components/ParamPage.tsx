import { useRef, useState } from 'react';
import { useParamStore } from '../store/paramStore';
import { useConnectionStore } from '../store/connectionStore';
import { parseParameterTable } from '../lib/paramParser';
import { ParamRow } from './ParamRow';
import { useModbusOps } from '../hooks/useModbusOps';

export function ParamPage() {
  const { pages, params, loadParams, activePage, search, setActivePage, setSearch } = useParamStore();
  const connected = useConnectionStore((s) => s.connected);
  const { readRegister } = useModbusOps();

  const [loading, setLoading] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 加载 Excel
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
    try {
      const { params: p, pages: pg } = await parseParameterTable(file);
      loadParams(p, pg);
      setActivePage(pg[0] ?? '');
    } catch (err) {
      console.error('parse failed', err);
    } finally {
      setLoading(false);
    }
  }

  // 当前页参数（过滤 hidden，支持搜索）
  const pageParams = params.filter(
    (p) =>
      !p.hidden &&
      p.page === activePage &&
      (search === '' ||
        p.alias.toLowerCase().includes(search.toLowerCase()) ||
        p.name.toLowerCase().includes(search.toLowerCase())),
  );

  // 批量读取
  async function handleReadAll() {
    const targets = params.filter((p) => !p.hidden && p.page === activePage);
    setBulkProgress({ done: 0, total: targets.length });
    for (let i = 0; i < targets.length; i++) {
      try {
        await readRegister(targets[i]);
      } catch {
        // 单条失败继续
      }
      setBulkProgress({ done: i + 1, total: targets.length });
    }
    setBulkProgress(null);
  }

  return (
    <div className="flex flex-col h-full">
      {/* 工具栏 */}
      <div className="flex items-center gap-3 px-4 py-2 bg-slate-800 border-b border-slate-700 flex-wrap">
        {/* 加载 Excel */}
        <button
          onClick={() => fileRef.current?.click()}
          className="px-3 py-1.5 bg-slate-600 hover:bg-slate-500 text-white rounded text-sm transition-colors"
        >
          📂 加载 ParameterTable.xlsx
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx"
          onChange={handleFileChange}
          className="hidden"
        />
        {loading && <span className="text-sm text-yellow-400">解析中…</span>}

        {/* 全部读取 */}
        {pages.length > 0 && (
          <button
            onClick={handleReadAll}
            disabled={!connected || bulkProgress !== null}
            className="px-3 py-1.5 bg-green-700 hover:bg-green-600 disabled:opacity-40
                       text-white rounded text-sm transition-colors w-36 text-center"
          >
            {bulkProgress
              ? `读取中 ${bulkProgress.done}/${bulkProgress.total}`
              : '↓ 全部读取'}
          </button>
        )}

        {/* 搜索 */}
        {pages.length > 0 && (
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索 alias / 名称…"
            className="ml-auto w-48 bg-slate-700 border border-slate-600 rounded px-3 py-1.5
                       text-slate-100 text-sm focus:outline-none focus:border-blue-500"
          />
        )}
      </div>

      {/* 空状态 */}
      {pages.length === 0 && (
        <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
          请先加载 ParameterTable.xlsx
        </div>
      )}

      {/* 页签 */}
      {pages.length > 0 && (
        <div className="flex gap-0 border-b border-slate-700 bg-slate-800 overflow-x-auto shrink-0">
          {pages.map((page) => (
            <button
              key={page}
              onClick={() => { setActivePage(page); setSearch(''); }}
              className={`px-4 py-2 text-sm whitespace-nowrap border-r border-slate-700 transition-colors ${
                activePage === page
                  ? 'bg-slate-900 text-blue-400 border-b-2 border-b-blue-500'
                  : 'text-slate-400 hover:bg-slate-700'
              }`}
            >
              {page}
            </button>
          ))}
        </div>
      )}

      {/* 参数表格 */}
      {pages.length > 0 && (
        <div className="flex-1 overflow-auto">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-slate-800 text-xs text-slate-400 border-b border-slate-700">
              <tr>
                <th className="px-3 py-2 text-left font-medium">ID</th>
                <th className="px-3 py-2 text-left font-medium">Alias</th>
                <th className="px-3 py-2 text-left font-medium">名称</th>
                <th className="px-3 py-2 text-left font-medium">单位</th>
                <th className="px-3 py-2 text-left font-medium">当前值</th>
                <th className="px-3 py-2 text-left font-medium">写入值</th>
                <th className="px-3 py-2 text-left font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {pageParams.map((param) => (
                <ParamRow key={param.id} param={param} />
              ))}
              {pageParams.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-slate-500 text-sm">
                    {search ? '未找到匹配参数' : '该页无参数'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
