import { useRef, useState, useCallback, useEffect } from 'react';
import { useBootloaderStore } from '../store/bootloaderStore';
import { Flasher } from '../lib/flasher';
import { loadFirmwareDocument } from '../lib/firmwareDocument';
import { currentConnectionTarget } from '../lib/apiClient';
import { bootloaderResponseTimeoutMs } from '../lib/blModbusClient';

// ── Modals ────────────────────────────────────────────────────────────────────

function SystemInfoModal({
  info,
  onClose,
}: {
  info: Awaited<ReturnType<Flasher['readSystemInfo']>>;
  onClose: () => void;
}) {
  const { bootloaderInfo: bl, flashInfo: fl, appInfo: ap, isBootloaderMode, isAppValid } = info;
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-slate-800 border border-slate-600 rounded-lg w-[480px] max-h-[80vh] overflow-y-auto p-5 text-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-slate-200 mb-4">MCU 系统信息</h2>

        <Section title="Bootloader">
          <KV k="Magic" v={`0x${(bl['magic'] as number).toString(16).padStart(4, '0')} (${isBootloaderMode ? '✓ BL模式' : '应用模式'})`} />
          <KV k="版本" v={`v${bl['majorVersion']}.${bl['minorVersion']}`} />
          <KV k="状态" v={`0x${(bl['state'] as number).toString(16)}`} />
          <KV k="能力" v={`0x${(bl['capability'] as number).toString(16)}`} />
          <KV k="错误码" v={`0x${(bl['errorCode'] as number).toString(16)}`} />
        </Section>

        <Section title="Flash">
          <KV k="总大小" v={`${fl['size']} 字节`} />
          <KV k="APP起始" v={`0x${(fl['appStart'] as number).toString(16)}`} />
          <KV k="APP最大" v={`${fl['appMaxSize']} 字节`} />
        </Section>

        <Section title={`APP ${isAppValid ? '✓ 有效' : '✗ 无效'}`}>
          <KV k="ValidFlag" v={`0x${(ap['validFlag'] as number).toString(16)}`} />
          <KV k="入口" v={`0x${(ap['entryAddr'] as number).toString(16)}`} />
          <KV k="版本" v={`v${ap['majorVersion']}.${ap['minorVersion']}`} />
          <KV k="起始地址" v={`0x${(ap['appStartAddr'] as number).toString(16)}`} />
          <KV k="长度" v={`${ap['appLength']} 字节`} />
          <KV k="CRC32" v={`0x${(ap['crc32'] as number).toString(16).padStart(8, '0')}`} />
          <KV k="Git Tag" v={String(ap['gitTag'] || '-')} />
        </Section>

        <button onClick={onClose} className="mt-4 px-4 py-1.5 bg-slate-600 hover:bg-slate-500 text-white rounded text-xs">
          关闭
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">{title}</div>
      <div className="bg-slate-900 rounded p-3 space-y-1">{children}</div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="text-slate-500 w-28 shrink-0">{k}</span>
      <span className="text-slate-200 font-mono">{v}</span>
    </div>
  );
}

function EraseModal({
  targets,
  onClose,
  onErase,
}: {
  targets: { id: string; label: string; protocolTargetCode: number; bootloaderErase?: { defaultStart: string; defaultEndExclusive: string } | null }[];
  onClose: () => void;
  onErase: (targetCode: number, start: number, end: number) => void;
}) {
  const [targetCode, setTargetCode] = useState(0);
  const [startHex, setStartHex] = useState('0xFFFFFFFF');
  const [endHex, setEndHex] = useState('0xFFFFFFFF');

  const selectedTarget = targets.find((t) => t.protocolTargetCode === targetCode);
  useEffect(() => {
    if (selectedTarget?.bootloaderErase) {
      setStartHex(selectedTarget.bootloaderErase.defaultStart);
      setEndHex(selectedTarget.bootloaderErase.defaultEndExclusive);
    } else {
      setStartHex('0xFFFFFFFF');
      setEndHex('0xFFFFFFFF');
    }
  }, [targetCode]);

  const handleErase = () => {
    const start = parseInt(startHex, 16);
    const end = parseInt(endHex, 16);
    onErase(targetCode, start, end - start);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-slate-800 border border-slate-600 rounded-lg w-96 p-5 text-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-slate-200 mb-4">擦除 Flash</h2>

        <label className="block mb-3">
          <span className="text-xs text-slate-400">目标</span>
          <select
            value={targetCode}
            onChange={(e) => setTargetCode(Number(e.target.value))}
            className="mt-1 w-full bg-slate-700 border border-slate-600 text-slate-200 rounded px-2 py-1.5 text-xs"
          >
            {targets.map((t) => (
              <option key={t.id} value={t.protocolTargetCode}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block mb-3">
          <span className="text-xs text-slate-400">起始地址（十六进制）</span>
          <input
            value={startHex}
            onChange={(e) => setStartHex(e.target.value)}
            className="mt-1 w-full bg-slate-700 border border-slate-600 text-slate-200 rounded px-2 py-1.5 text-xs font-mono"
          />
        </label>

        <label className="block mb-4">
          <span className="text-xs text-slate-400">结束地址（不含，十六进制）</span>
          <input
            value={endHex}
            onChange={(e) => setEndHex(e.target.value)}
            className="mt-1 w-full bg-slate-700 border border-slate-600 text-slate-200 rounded px-2 py-1.5 text-xs font-mono"
          />
        </label>

        <div className="flex gap-2">
          <button
            onClick={handleErase}
            className="px-4 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded text-xs font-medium"
          >
            执行擦除
          </button>
          <button onClick={onClose} className="px-4 py-1.5 bg-slate-600 hover:bg-slate-500 text-white rounded text-xs">
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Log color ──────────────────────────────────────────────────────────────────

function logColor(type: string) {
  switch (type) {
    case 'error':   return 'text-red-400';
    case 'success': return 'text-green-400';
    case 'warning': return 'text-yellow-400';
    default:        return 'text-slate-300';
  }
}

// ── Main component ────────────────────────────────────────────────────────────

export function BootloaderPage() {
  const {
    guiConfig,
    firmwareFormat, setFirmwareFormat,
    activeTargetId, setActiveTargetId,
    flashTargetIds, toggleFlashTarget,
    chunkSize, setChunkSize,
    hex2File, setHex2File,
    legacyFiles, setLegacyFile,
    isFlashing, setFlashing,
    statusText, setStatus,
    progressPct, setProgress,
    progressDetails,
    logs, addLog, clearLogs,
    firmwareDocument, setFirmwareDocument,
  } = useBootloaderStore();

  const hex2InputRef = useRef<HTMLInputElement>(null);
  const legacyInputRefs = useRef<Record<string, Record<string, HTMLInputElement | null>>>({});
  const flasherRef = useRef<Flasher | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const [sysInfo, setSysInfo] = useState<Awaited<ReturnType<Flasher['readSystemInfo']>> | null>(null);
  const [showEraseModal, setShowEraseModal] = useState(false);

  // auto scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [logs]);

  const makeFlasher = useCallback(() => {
    const responseTimeoutMs = bootloaderResponseTimeoutMs(currentConnectionTarget().kind);
    return new Flasher(0xff, {
      onLog: (msg, type = 'info') => addLog(msg, type),
      onStatus: (s, msg) => setStatus(s, msg),
      onProgress: (_cur, _tot, pct) => setProgress(pct, `${pct}%`),
    }, { responseTimeoutMs });
  }, [addLog, setStatus, setProgress]);

  // ── Load firmware document ─────────────────────────────────────────────────

  const handleLoadFirmware = useCallback(async () => {
    setStatus('loading', '解析固件文件...');
    addLog('开始解析固件文件...');
    try {
      const doc = await loadFirmwareDocument({
        firmwareFormat,
        hex2File: firmwareFormat === 'hex2' ? hex2File : null,
        targetType: activeTargetId,
        legacyFiles,
        targetDefinitions: guiConfig.targets,
      });
      setFirmwareDocument(doc);
      addLog(`固件解析成功：${doc.listTargets().map((t) => t.target).join(', ')}`, 'success');
      setStatus('ready', '固件已加载');
    } catch (e) {
      addLog(`固件解析失败: ${(e as Error).message}`, 'error');
      setStatus('error', '固件解析失败');
    }
  }, [firmwareFormat, hex2File, activeTargetId, legacyFiles, guiConfig, addLog, setStatus, setFirmwareDocument]);

  // ── Flash ──────────────────────────────────────────────────────────────────

  const handleFlash = useCallback(async () => {
    if (isFlashing) return;
    if (!firmwareDocument) {
      addLog('请先加载固件文件', 'error');
      return;
    }

    const sortedTargets = guiConfig.targets
      .filter((t) => flashTargetIds.includes(t.id))
      .sort((a, b) => a.flashPriority - b.flashPriority);

    if (sortedTargets.length === 0) {
      addLog('请至少选择一个烧录目标', 'error');
      return;
    }

    setFlashing(true);
    setProgress(0, '');
    const flasher = makeFlasher();
    flasherRef.current = flasher;

    for (const target of sortedTargets) {
      const image = firmwareDocument.getTarget(target.firmwareTarget);
      if (!image) {
        addLog(`目标 ${target.displayName} 的固件镜像不存在，跳过`, 'warning');
        continue;
      }
      const result = await flasher.flashParsedImage(image, target.protocolTargetCode, target.displayName, chunkSize);
      if (!result.success) break;
    }

    setFlashing(false);
    flasherRef.current = null;
  }, [isFlashing, firmwareDocument, guiConfig, flashTargetIds, chunkSize, makeFlasher, addLog, setFlashing, setProgress]);

  const handleStop = useCallback(() => {
    flasherRef.current?.stop();
  }, []);

  // ── Quick ops ──────────────────────────────────────────────────────────────

  const handleEnterBL = useCallback(async () => {
    const f = makeFlasher();
    try {
      const r = await f.enterBootloaderMode();
      addLog(r.message, 'success');
    } catch (e) {
      addLog(`失败: ${(e as Error).message}`, 'error');
    }
  }, [makeFlasher, addLog]);

  const handleJumpToApp = useCallback(async () => {
    const f = makeFlasher();
    try {
      const r = await f.jumpToApplication();
      addLog(r.message, 'success');
    } catch (e) {
      addLog(`失败: ${(e as Error).message}`, 'error');
    }
  }, [makeFlasher, addLog]);

  const handleReadSysInfo = useCallback(async () => {
    const activeTarget = guiConfig.targets.find((t) => t.id === activeTargetId);
    const targetCode = activeTarget?.protocolTargetCode ?? 0;
    const f = makeFlasher();
    try {
      const info = await f.readSystemInfo(targetCode);
      setSysInfo(info);
      addLog('读取系统信息成功', 'success');
    } catch (e) {
      addLog(`读取系统信息失败: ${(e as Error).message}`, 'error');
    }
  }, [makeFlasher, addLog, guiConfig, activeTargetId]);

  const handleErase = useCallback(async (targetCode: number, start: number, length: number) => {
    const f = makeFlasher();
    addLog(`开始擦除 Flash (目标=${targetCode}, 起始=0x${start.toString(16)}, 长度=${length})...`);
    try {
      const r = await f.eraseFlashRange(start, length, targetCode);
      addLog(`擦除成功: 起始=0x${r.startAddr.toString(16)}, 长度=${r.length}`, 'success');
    } catch (e) {
      addLog(`擦除失败: ${(e as Error).message}`, 'error');
    }
  }, [makeFlasher, addLog]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── 左侧配置面板 ── */}
      <aside className="w-72 shrink-0 bg-slate-800 border-r border-slate-700 overflow-y-auto flex flex-col">

        {/* 固件来源 */}
        <div className="px-4 py-2">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">固件格式</div>
          <div className="flex gap-4 text-xs text-slate-300">
            {(['hex2', 'legacy'] as const).map((fmt) => (
              <label key={fmt} className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="firmware-format"
                  value={fmt}
                  checked={firmwareFormat === fmt}
                  onChange={() => setFirmwareFormat(fmt)}
                  className="accent-blue-500"
                />
                {fmt === 'hex2' ? 'HEX2 (推荐)' : 'Legacy HEX'}
              </label>
            ))}
          </div>
        </div>

        {/* 固件文件 */}
        <div className="px-4 py-2">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">固件文件</div>

          {firmwareFormat === 'hex2' ? (
            <div>
              <input
                type="file"
                accept=".hex2"
                className="hidden"
                ref={hex2InputRef}
                onChange={(e) => { setHex2File(e.target.files?.[0] ?? null); e.target.value = ''; }}
              />
              <div className="flex gap-2 items-center">
                <button
                  onClick={() => hex2InputRef.current?.click()}
                  className="px-3 py-1.5 rounded text-xs font-medium bg-slate-600 hover:bg-slate-500 text-white transition-colors"
                >
                  选择 .hex2
                </button>
                <span className="text-xs text-slate-400 truncate">{hex2File?.name ?? '未选择'}</span>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {guiConfig.targets.filter((t) => t.legacySupported).map((target) => (
                <div key={target.id}>
                  <div className="text-xs text-slate-400 mb-1">{target.displayName}</div>
                  {target.bitWidth === 16 ? (
                    <div className="space-y-1">
                      {(['low', 'high'] as const).map((role) => (
                        <div key={role} className="flex gap-2 items-center">
                          <input
                            type="file"
                            accept=".hex"
                            className="hidden"
                            ref={(el) => {
                              if (!legacyInputRefs.current[target.id]) legacyInputRefs.current[target.id] = {};
                              legacyInputRefs.current[target.id][role] = el;
                            }}
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) setLegacyFile(target.id, role, f);
                              e.target.value = '';
                            }}
                          />
                          <button
                            onClick={() => legacyInputRefs.current[target.id]?.[role]?.click()}
                            className="px-2 py-1 rounded text-xs bg-slate-600 hover:bg-slate-500 text-white"
                          >
                            {role === 'low' ? '低字节' : '高字节'}
                          </button>
                          <span className="text-xs text-slate-400 truncate">
                            {legacyFiles[target.id]?.[role]?.name ?? '未选择'}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex gap-2 items-center">
                      <input
                        type="file"
                        accept=".hex"
                        className="hidden"
                        ref={(el) => {
                          if (!legacyInputRefs.current[target.id]) legacyInputRefs.current[target.id] = {};
                          legacyInputRefs.current[target.id]['single'] = el;
                        }}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) setLegacyFile(target.id, 'single', f);
                          e.target.value = '';
                        }}
                      />
                      <button
                        onClick={() => legacyInputRefs.current[target.id]?.['single']?.click()}
                        className="px-2 py-1 rounded text-xs bg-slate-600 hover:bg-slate-500 text-white"
                      >
                        HEX
                      </button>
                      <span className="text-xs text-slate-400 truncate">
                        {legacyFiles[target.id]?.['single']?.name ?? '未选择'}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <button
            onClick={handleLoadFirmware}
            className="mt-3 w-full px-3 py-1.5 rounded text-xs font-medium bg-slate-600 hover:bg-slate-500 text-white transition-colors"
          >
            📂 解析固件
          </button>
          {firmwareDocument && (
            <div className="mt-1 text-xs text-green-400">
              ✓ 已加载：{firmwareDocument.listTargets().map((t) => t.target).join(', ')}
            </div>
          )}
        </div>

        <Divider />

        {/* 目标选择 */}
        <div className="px-4 py-2">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">当前目标</div>
          <div className="space-y-1">
            {guiConfig.targets.map((t) => (
              <label key={t.id} className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="radio"
                  name="active-target"
                  value={t.id}
                  checked={activeTargetId === t.id}
                  onChange={() => setActiveTargetId(t.id)}
                  className="accent-blue-500"
                />
                {t.displayName}
              </label>
            ))}
          </div>
        </div>

        {/* 烧录目标（多选） */}
        <div className="px-4 py-2">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">烧录目标</div>
          <div className="space-y-1">
            {guiConfig.targets.map((t) => (
              <label key={t.id} className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={flashTargetIds.includes(t.id)}
                  onChange={() => toggleFlashTarget(t.id)}
                  className="accent-blue-500"
                />
                {t.displayName}
              </label>
            ))}
          </div>
        </div>

        <Divider />

        {/* 操作按钮 */}
        <div className="px-4 py-2 space-y-2">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">烧录操作</div>
          {!isFlashing ? (
            <button
              onClick={handleFlash}
              disabled={!firmwareDocument}
              className="w-full px-3 py-2 rounded text-xs font-semibold bg-green-600 hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
            >
              🚀 开始烧录
            </button>
          ) : (
            <button
              onClick={handleStop}
              className="w-full px-3 py-2 rounded text-xs font-semibold bg-red-600 hover:bg-red-500 text-white transition-colors"
            >
              ⏹ 停止
            </button>
          )}
        </div>

        <Divider />

        {/* 快捷操作 */}
        <div className="px-4 py-2 space-y-1.5">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">快捷操作</div>
          <button onClick={handleEnterBL} className="w-full text-left px-3 py-1.5 rounded text-xs bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors">
            进入 Bootloader 模式
          </button>
          <button onClick={handleJumpToApp} className="w-full text-left px-3 py-1.5 rounded text-xs bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors">
            跳转到应用程序
          </button>
          <button onClick={handleReadSysInfo} className="w-full text-left px-3 py-1.5 rounded text-xs bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors">
            查看 MCU 信息
          </button>
          <button onClick={() => setShowEraseModal(true)} className="w-full text-left px-3 py-1.5 rounded text-xs bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors">
            擦除 Flash...
          </button>
        </div>

        <Divider />

        {/* 高级设置 */}
        <div className="px-4 py-2 pb-4">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">高级设置</div>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <span className="w-20 shrink-0">块大小 (字节)</span>
            <input
              type="number"
              min={8}
              max={240}
              step={8}
              value={chunkSize}
              onChange={(e) => setChunkSize(Number(e.target.value))}
              className="flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-slate-200 text-xs"
            />
          </label>
        </div>
      </aside>

      {/* ── 右侧主区域 ── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* 进度区 */}
        <div className="shrink-0 px-4 pt-3 pb-2 border-b border-slate-700 bg-slate-900">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-medium text-slate-300">{statusText}</span>
            <span className="text-xs text-slate-500">{progressDetails}</span>
          </div>
          <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-600 transition-all duration-150"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>

        {/* 日志区 */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-2 shrink-0 border-b border-slate-700">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">烧录日志</span>
            <span className="text-xs text-slate-600">{logs.length} 条</span>
            <button
              onClick={clearLogs}
              className="ml-auto px-3 py-1 rounded text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"
            >
              🗑 清空
            </button>
          </div>
          <div className="flex-1 overflow-y-auto font-mono text-xs bg-slate-950 p-3 space-y-0.5">
            {logs.length === 0 && (
              <div className="text-slate-600 text-center py-8">暂无日志</div>
            )}
            {logs.map((entry) => (
              <div key={entry.id} className={`flex gap-2 px-1 py-0.5 ${logColor(entry.type)}`}>
                <span className="shrink-0 text-slate-600 w-16 text-right">{entry.timestamp}</span>
                <span>{entry.msg}</span>
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        </div>
      </div>

      {/* ── Modals ── */}
      {sysInfo && (
        <SystemInfoModal info={sysInfo} onClose={() => setSysInfo(null)} />
      )}
      {showEraseModal && (
        <EraseModal
          targets={guiConfig.targets}
          onClose={() => setShowEraseModal(false)}
          onErase={handleErase}
        />
      )}
    </div>
  );
}

function Divider() {
  return <div className="border-t border-slate-700 mx-2 my-1" />;
}
