/**
 * GUI 配置类型与校验（浏览器版）
 * 移植自 bl_electron_gui/src/gui-config.js
 * 去除 fs/path 依赖，仅保留纯逻辑
 */

export interface BootloaderErase {
  enabled: boolean;
  defaultStart: string;
  defaultEndExclusive: string;
  editable: boolean;
}

export interface GuiTarget {
  id: string;
  firmwareTarget: string;
  label: string;
  displayName: string;
  bitWidth: 8 | 16;
  protocolTargetCode: number;
  flashPriority: number;
  legacySupported: boolean;
  bootloaderErase: BootloaderErase | null;
}

export interface GuiConfig {
  defaultFirmwareFormat: 'hex2' | 'legacy';
  defaultTarget: string;
  appInfoTarget: string;
  targets: GuiTarget[];
}

export const DEFAULT_GUI_CONFIG: GuiConfig = {
  defaultFirmwareFormat: 'hex2',
  defaultTarget: 'main',
  appInfoTarget: 'main',
  targets: [
    {
      id: 'main',
      firmwareTarget: 'cpu1',
      label: '主MCU',
      displayName: 'CPU1',
      bitWidth: 16,
      protocolTargetCode: 0,
      flashPriority: 1,
      legacySupported: true,
      bootloaderErase: {
        enabled: true,
        defaultStart: '0x00080000',
        defaultEndExclusive: '0x00088000',
        editable: true,
      },
    },
  ],
};

function parseConfigAddress(value: unknown): number {
  const text = String(value ?? '').trim();
  if (!text) return NaN;
  if (text.startsWith('0x') || text.startsWith('0X')) return parseInt(text, 16);
  return parseInt(text, 10);
}

function normalizeTarget(target: unknown, index: number): GuiTarget {
  if (!target || typeof target !== 'object') {
    throw new Error(`目标配置无效: ${index}`);
  }
  const t = target as Record<string, unknown>;

  const id = String(t['id'] ?? '').trim();
  const firmwareTarget = String(t['firmwareTarget'] ?? '').trim();
  const label = String(t['label'] ?? '').trim();
  const displayName = String(t['displayName'] ?? label ?? id).trim();
  const bitWidth = Number(t['bitWidth']);
  const protocolTargetCode = Number(t['protocolTargetCode']);
  const flashPriority = Number.isFinite(Number(t['flashPriority']))
    ? Number(t['flashPriority'])
    : index + 1;

  if (!id || !firmwareTarget || !label) {
    throw new Error(`目标配置缺少必要字段: ${JSON.stringify(target)}`);
  }
  if (bitWidth !== 8 && bitWidth !== 16) {
    throw new Error(`目标 ${id} 的 bitWidth 必须为 8 或 16`);
  }
  if (!Number.isInteger(protocolTargetCode) || protocolTargetCode < 0 || protocolTargetCode > 255) {
    throw new Error(`目标 ${id} 的 protocolTargetCode 无效`);
  }

  let bootloaderErase: BootloaderErase | null = null;
  const rawErase = t['bootloaderErase'];
  if (rawErase && typeof rawErase === 'object') {
    const e = rawErase as Record<string, unknown>;
    bootloaderErase = {
      enabled: Boolean(e['enabled']),
      defaultStart: String(e['defaultStart'] ?? ''),
      defaultEndExclusive: String(e['defaultEndExclusive'] ?? ''),
      editable: e['editable'] !== false,
    };
    if (bootloaderErase.enabled) {
      const start = parseConfigAddress(bootloaderErase.defaultStart);
      const end = parseConfigAddress(bootloaderErase.defaultEndExclusive);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        throw new Error(`目标 ${id} 的 bootloaderErase 默认地址范围无效`);
      }
    }
  }

  return {
    id,
    firmwareTarget,
    label,
    displayName,
    bitWidth: bitWidth as 8 | 16,
    protocolTargetCode,
    flashPriority,
    legacySupported: t['legacySupported'] !== false,
    bootloaderErase,
  };
}

export function normalizeGuiConfig(raw: unknown): GuiConfig {
  const base = DEFAULT_GUI_CONFIG as unknown as Record<string, unknown>;
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const merged = { ...base, ...input };

  const rawTargets = Array.isArray(merged['targets']) ? (merged['targets'] as unknown[]) : [];
  const targets = rawTargets.map((t, i) => normalizeTarget(t, i));
  if (targets.length === 0) throw new Error('GUI 配置中至少需要一个目标');

  const idSet = new Set<string>();
  const ftSet = new Set<string>();
  for (const t of targets) {
    if (idSet.has(t.id)) throw new Error(`目标 id 重复: ${t.id}`);
    if (ftSet.has(t.firmwareTarget)) throw new Error(`firmwareTarget 重复: ${t.firmwareTarget}`);
    idSet.add(t.id);
    ftSet.add(t.firmwareTarget);
  }

  const defaultTarget = idSet.has(String(merged['defaultTarget'] ?? ''))
    ? String(merged['defaultTarget'])
    : targets[0].id;
  const appInfoTarget = idSet.has(String(merged['appInfoTarget'] ?? ''))
    ? String(merged['appInfoTarget'])
    : defaultTarget;

  return {
    defaultFirmwareFormat: merged['defaultFirmwareFormat'] === 'legacy' ? 'legacy' : 'hex2',
    defaultTarget,
    appInfoTarget,
    targets,
  };
}
