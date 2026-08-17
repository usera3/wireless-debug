import { useRef, useState } from 'react';
import { useParamStore } from '../store/paramStore';
import { useConnectionStore } from '../store/connectionStore';
import { parseParameterTable } from '../lib/paramParser';
import { ParamRow } from './ParamRow';
import { useModbusOps } from '../hooks/useModbusOps';
import { EspFilePicker } from './EspFilePicker';
import { apiFetch, currentConnectionTarget } from '../lib/apiClient';
import { parameterSourcePolicy } from '../lib/parameterSourcePolicy';
import { buildParameterUploadRequest } from '../lib/parameterFileUpload';

export function ParamPage() {
  const { pages, params, loadParams, activePage, search, setActivePage, setSearch } = useParamStore();
  const connected = useConnectionStore((s) => s.connected);
  const { readRegisters } = useModbusOps();

  const [loading, setLoading] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number; mode: 'page' | 'all' } | null>(null);
  const [bulkStatus, setBulkStatus] = useState<{ type: 'info' | 'error'; message: string } | null>(null);
  const [showEspPicker, setShowEspPicker] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(false);
  const sourcePolicy = parameterSourcePolicy(currentConnectionTarget().kind);

  // 加载 Excel（本地文件 or ESP32 下载后传入）
  async function loadFile(file: File) {
    setLoading(true);
    try {
      const parsed = await parseParameterTable(file);
      if (currentConnectionTarget().kind === 'cloud') {
        const request = await buildParameterUploadRequest('/api/excel/upload', file);
        const { url, ...init } = request;
        const response = await apiFetch(url, init);
        if (!response.ok) throw new Error(`参数表上传失败：HTTP ${response.status}`);
      }
      const { params: p, pages: pg } = parsed;
      loadParams(p, pg);
      setActivePage(pg[0] ?? '');
    } catch (err) {
      console.error('parse failed', err);
    } finally {
      setLoading(false);
    }
  }

  function formatBulkError(err: unknown): string {
    return err instanceof Error ? err.message : '读取失败';
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    await loadFile(file);
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
  async function handleReadPage() {
    const targets = params.filter((p) => !p.hidden && p.page === activePage);
    cancelRef.current = false;
    setBulkStatus(null);
    setBulkProgress({ done: 0, total: targets.length, mode: 'page' });
    try {
      if (!cancelRef.current) {
        const done = await readRegisters(targets);
        setBulkProgress({ done, total: targets.length, mode: 'page' });
        setBulkStatus({ type: 'info', message: `当前页已读取 ${done}/${targets.length}` });
      }
    } catch (err) {
      setBulkStatus({ type: 'error', message: `当前页读取失败：${formatBulkError(err)}` });
    }
    setBulkProgress(null);
  }

  async function handleReadAll() {
    const targets = params.filter((p) => !p.hidden);
    cancelRef.current = false;
    setBulkStatus(null);
    setBulkProgress({ done: 0, total: targets.length, mode: 'all' });
    let done = 0;
    let failed = 0;
    for (const page of pages) {
      if (cancelRef.current) break;
      const pageTargets = targets.filter((target) => target.page === page);
      if (pageTargets.length === 0) continue;
      setActivePage(page);
      try {
        done += await readRegisters(pageTargets);
      } catch (err) {
        failed += 1;
        setBulkStatus({ type: 'error', message: `${page} 读取失败：${formatBulkError(err)}` });
      }
      setBulkProgress({ done, total: targets.length, mode: 'all' });
    }
    if (!cancelRef.current && failed === 0) {
      setBulkStatus({ type: 'info', message: `所有页已读取 ${done}/${targets.length}` });
    }
    setBulkProgress(null);
  }

  return (
    <div className="flex flex-col h-full">
      {/* 工具栏 */}
      <div className="flex items-center gap-3 px-4 py-2 bg-slate-800 border-b border-slate-700 flex-wrap">
        {/* 加载 Excel */}
        {sourcePolicy.showLocalFilePicker && (
          <>
            <button
              onClick={() => fileRef.current?.click()}
              className="px-3 py-1.5 bg-slate-600 hover:bg-slate-500 text-white rounded text-sm transition-colors"
            >
              📂 本地参数表
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx"
              onChange={handleFileChange}
              className="hidden"
            />
          </>
        )}

        {/* 从 ESP32 加载 */}
        <button
          onClick={() => setShowEspPicker(true)}
          className="px-3 py-1.5 bg-slate-600 hover:bg-slate-500 text-white rounded text-sm transition-colors"
        >
          📡 {sourcePolicy.remoteButtonLabel}
        </button>

        {loading && <span className="text-sm text-yellow-400">解析中…</span>}

        {/* 读取按钮组 */}
        {pages.length > 0 && (
          <div className="flex items-center gap-1">
            <span className="text-sm text-slate-400 mr-1">读取：</span>
            <button
              onClick={bulkProgress?.mode === 'page' ? () => { cancelRef.current = true; } : handleReadPage}
              disabled={!connected || bulkProgress?.mode === 'all'}
              className={`px-3 py-1.5 text-white rounded text-sm transition-colors text-center disabled:opacity-40
                ${bulkProgress?.mode === 'page'
                  ? 'bg-red-700 hover:bg-red-600'
                  : 'bg-green-700 hover:bg-green-600'}`}
            >
              {bulkProgress?.mode === 'page'
                ? `${bulkProgress.done}/${bulkProgress.total}`
                : '当前页'}
            </button>
            <button
              onClick={bulkProgress?.mode === 'all' ? () => { cancelRef.current = true; } : handleReadAll}
              disabled={!connected || bulkProgress?.mode === 'page'}
              className={`px-3 py-1.5 text-white rounded text-sm transition-colors text-center disabled:opacity-40
                ${bulkProgress?.mode === 'all'
                  ? 'bg-red-700 hover:bg-red-600'
                  : 'bg-green-700 hover:bg-green-600'}`}
            >
              {bulkProgress?.mode === 'all'
                ? `${bulkProgress.done}/${bulkProgress.total}`
                : '所有页'}
            </button>
          </div>
        )}

        {bulkStatus && (
          <span className={`text-xs ${bulkStatus.type === 'error' ? 'text-red-400' : 'text-green-400'}`}>
            {bulkStatus.message}
          </span>
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
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">ID</th>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">名称</th>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">单位</th>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">当前值</th>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">写入值</th>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody>
              {pageParams.map((param) => (
                <ParamRow key={param.id} param={param} />
              ))}
              {pageParams.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-slate-500 text-sm">
                    {search ? '未找到匹配参数' : '该页无参数'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ESP32 Excel 文件选择弹窗 */}
      {showEspPicker && (
        <EspFilePicker
          onFileReady={(file) => loadFile(file)}
          onClose={() => setShowEspPicker(false)}
          policy={sourcePolicy}
        />
      )}

    </div>
  );
}
