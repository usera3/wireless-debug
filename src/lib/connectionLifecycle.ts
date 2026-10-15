const cleanups = new Set<() => void>();
export function registerConnectionCleanup(cleanup: () => void): void { cleanups.add(cleanup); }
export function cleanupConnectionActivity(): void { cleanups.forEach(cleanup => cleanup()); }
