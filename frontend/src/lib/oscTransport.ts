import type { ConnectionTarget } from './connectionTarget';

export function shouldStopOscOnDisconnect(kind: ConnectionTarget['kind']): boolean {
  return kind !== 'cloud';
}
