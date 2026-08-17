import { useEffect, useRef, useState } from 'react';
import { apiFetch, apiUrl, currentConnectionTarget } from '../lib/apiClient';
import type { ParameterSourcePolicy } from '../lib/parameterSourcePolicy';
import {
  ESP_PARAMETER_FILENAME_MAX_BYTES,
  getEspParameterFilenameTransportLength,
  isEspParameterFilenameSupported,
} from '../lib/parameterFilename';
import { buildParameterUploadRequest } from '../lib/parameterFileUpload';

interface Props {
  /** 选中并成功下载文件后的回调，传入 File 对象供 parseParameterTable 使用 */
  onFileReady: (file: File) => void;
  onClose: () => void;
  policy: ParameterSourcePolicy;
}

type StatusCls = '' | 'ok' | 'err' | 'ing';

export function EspFilePicker({ onFileReady, onClose, policy }: Props) {
  const [files, setFiles] = useState<string[]>([]);
  const [status, setStatus] = useState<{ msg: string; cls: StatusCls }>({ msg: '', cls: '' });
  const [progress, setProgress] = useState(0);
  const uploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    refreshList();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function st(msg: string, cls: StatusCls = '') {
    setStatus({ msg, cls });
  }

  async function refreshList() {
    st('正在获取文件列表...', 'ing');
    try {
      const list: string[] = await apiFetch('/api/excel/list').then((r) => r.json());
      setFiles(list);
      st(list.length ? `共 ${list.length} 个文件` : '', list.length ? 'ok' : '');
    } catch (e) {
      st(`❌ 获取列表失败：${(e as Error).message}`, 'err');
    }
  }

  async function handleUpload(file: File) {
    const isCloud = currentConnectionTarget().kind === 'cloud';
    const filenameLength = getEspParameterFilenameTransportLength(file.name);
    if (!isCloud && !isEspParameterFilenameSupported(file.name)) {
      st(`⚠️ 文件名过长（${filenameLength} 字节），设备最多支持 ${ESP_PARAMETER_FILENAME_MAX_BYTES} 字节`, 'err');
      return;
    }
    st(`正在上传 ${file.name}（${(file.size / 1024).toFixed(1)} KB）...`, 'ing');
    setProgress(5);
    try {
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', apiUrl('/api/excel/upload'));
        if (!isCloud) xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 95));
        };
        xhr.onload = () => (xhr.status === 200 ? resolve() : reject(new Error(xhr.responseText)));
        xhr.onerror = () => reject(new Error('网络错误'));
        if (isCloud) {
          void buildParameterUploadRequest('/api/excel/upload', file).then((request) => {
            Object.entries(request.headers).forEach(([name, value]) => xhr.setRequestHeader(name, value));
            xhr.send(request.body);
          }).catch(reject);
        } else {
          xhr.send(file);
        }
      });
      setProgress(100);
      setTimeout(() => setProgress(0), 800);
      st(`✅ 上传成功：${file.name}`, 'ok');
      refreshList();
    } catch (e) {
      setProgress(0);
      st(`❌ 上传失败：${(e as Error).message}`, 'err');
    }
  }

  async function deleteFile(filename: string) {
    if (!confirm(`确认删除「${filename}」？此操作不可恢复。`)) return;
    st(`正在删除 ${filename}...`, 'ing');
    try {
      const res = await apiFetch(`/api/excel/delete?name=${encodeURIComponent(filename)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(await res.text());
      st(`🗑 已删除：${filename}`, 'ok');
      refreshList();
    } catch (e) {
      st(`❌ 删除失败：${(e as Error).message}`, 'err');
    }
  }

  async function selectFile(filename: string) {
    st(`正在加载 ${filename}...`, 'ing');
    try {
      const res = await apiFetch(`/excel/${encodeURIComponent(filename)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const file = new File([buf], filename, {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      st(`✅ 已选择：${filename}，解析中...`, 'ok');
      onFileReady(file);
      setTimeout(onClose, 800);
    } catch (e) {
      st(`❌ 加载失败：${(e as Error).message}`, 'err');
    }
  }

  const statusColor =
    status.cls === 'ok' ? 'text-green-400' :
    status.cls === 'err' ? 'text-red-400' :
    status.cls === 'ing' ? 'text-blue-400' :
    'text-slate-400';

  return (
    /* 遮罩 */
    <div
      className="fixed inset-0 bg-black/65 z-50 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-slate-800 border border-slate-600 rounded-2xl p-6 min-w-[380px] max-w-[92vw] shadow-2xl">
        <h3 className="text-base font-semibold text-slate-100 mb-4 pb-2.5 border-b border-slate-700">
          📡 {policy.remoteDialogTitle}
        </h3>

        {/* 文件列表 */}
        <ul className="max-h-[280px] overflow-y-auto mb-4 space-y-0">
          {files.length === 0 && status.cls !== 'ing' ? (
            <li className="py-2 text-sm text-slate-500">{policy.emptyMessage}</li>
          ) : (
            files.map((name) => (
              <li
                key={name}
                className="flex items-center gap-2 py-2 border-b border-slate-700/60 last:border-0 text-sm"
              >
                <span className="flex-1 break-all text-slate-300">📄 {name}</span>
                <button
                  onClick={() => selectFile(name)}
                  className="shrink-0 bg-indigo-600 hover:opacity-80 text-white rounded-md px-3 py-1 text-xs transition-opacity"
                >
                  选择加载
                </button>
                {policy.allowRemoteDelete && (
                  <button
                    onClick={() => deleteFile(name)}
                    className="shrink-0 border border-red-400 text-red-400 hover:bg-red-400 hover:text-white rounded-md px-2.5 py-1 text-xs transition-all"
                  >
                    🗑 删除
                  </button>
                )}
              </li>
            ))
          )}
        </ul>

        {/* 底部操作行 */}
        <div className="flex items-center gap-2 flex-wrap">
          {policy.allowRemoteUpload && (
            <>
              <button
                onClick={() => uploadRef.current?.click()}
                className="bg-slate-700 hover:opacity-80 border border-slate-500 text-slate-200 rounded-md px-3.5 py-1.5 text-xs transition-opacity"
              >
                ⬆️ 上传新文件
              </button>
              <input
                ref={uploadRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) { handleUpload(f); e.target.value = ''; }
                }}
              />
            </>
          )}
          <button
            onClick={refreshList}
            className="bg-slate-700 hover:opacity-80 border border-slate-500 text-slate-200 rounded-md px-3.5 py-1.5 text-xs transition-opacity"
          >
            🔄 刷新列表
          </button>
          <button
            onClick={onClose}
            className="ml-auto border border-slate-500 text-slate-400 hover:text-slate-100 rounded-md px-3.5 py-1.5 text-xs transition-colors"
          >
            ✕ 关闭
          </button>
        </div>

        {/* 进度条 */}
        {progress > 0 && (
          <div className="mt-3 h-[3px] bg-slate-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-indigo-500 transition-[width] duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        {/* 状态文字 */}
        {status.msg && (
          <p className={`mt-2 text-xs break-all min-h-[18px] ${statusColor}`}>{status.msg}</p>
        )}
      </div>
    </div>
  );
}
