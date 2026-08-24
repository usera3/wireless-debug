import type { ConnectionTarget } from './connectionTarget';

export interface OscCapabilities {
  frameLen: number;
  maxChannels: number;
  sampleRate: number;
}

export type OscStartupMode = 'strict' | 'cloud-cached';

interface StoredOscCapabilities extends OscCapabilities {
  version: 1;
  savedAt: number;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = 'wireless-debug:osc-capabilities:';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function validCapabilities(value: Partial<OscCapabilities>): value is OscCapabilities {
  return Number.isInteger(value.frameLen) && value.frameLen! >= 32 && value.frameLen! <= 512
    && Number.isInteger(value.maxChannels) && value.maxChannels! >= 1 && value.maxChannels! <= 32
    && Number.isInteger(value.sampleRate) && value.sampleRate! >= 100 && value.sampleRate! <= 100_000;
}

export function oscCapabilityTargetKey(target: ConnectionTarget): string | null {
  if (target.kind === 'cloud') return `cloud:${target.deviceId}`;
  if (target.kind === 'local') return `local:${target.apiBase}`;
  return null;
}

export function createOscCapabilityCache(storage: StorageLike, now: () => number = Date.now) {
  function keyFor(target: ConnectionTarget): string | null {
    const targetKey = oscCapabilityTargetKey(target);
    return targetKey ? `${PREFIX}${targetKey}` : null;
  }

  return {
    read(target: ConnectionTarget): OscCapabilities | null {
      const key = keyFor(target);
      if (!key) return null;
      try {
        const raw = storage.getItem(key);
        if (!raw) return null;
        const stored = JSON.parse(raw) as Partial<StoredOscCapabilities>;
        if (stored.version !== 1 || !Number.isFinite(stored.savedAt)
          || now() - stored.savedAt! > MAX_AGE_MS || !validCapabilities(stored)) {
          storage.removeItem(key);
          return null;
        }
        return {
          frameLen: stored.frameLen,
          maxChannels: stored.maxChannels,
          sampleRate: stored.sampleRate,
        };
      } catch {
        storage.removeItem(key);
        return null;
      }
    },

    write(target: ConnectionTarget, capabilities: OscCapabilities) {
      const key = keyFor(target);
      if (!key) return;
      if (!validCapabilities(capabilities)) {
        storage.removeItem(key);
        return;
      }
      const stored: StoredOscCapabilities = {
        version: 1,
        savedAt: now(),
        ...capabilities,
      };
      storage.setItem(key, JSON.stringify(stored));
    },
  };
}

const browserStorage: StorageLike = typeof window !== 'undefined'
  ? window.localStorage
  : { getItem: () => null, setItem: () => {}, removeItem: () => {} };

export const oscCapabilityCache = createOscCapabilityCache(browserStorage);

export function selectOscStartupMode(
  target: ConnectionTarget,
  cached: OscCapabilities | null,
): OscStartupMode {
  return target.kind === 'cloud' && cached ? 'cloud-cached' : 'strict';
}
