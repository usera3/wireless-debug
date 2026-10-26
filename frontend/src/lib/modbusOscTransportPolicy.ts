import type { ConnectionTarget } from './connectionTarget';

type ConnectionKind = ConnectionTarget['kind'];
export type ModbusOscCycleAction = 'append' | 'continue' | 'stop';
export const CLOUD_MODBUS_OSC_MAX_CONSECUTIVE_FAILURES = 3;

export function modbusOscResponseTimeoutMs(kind: ConnectionKind): number {
  return kind === 'cloud' ? 2800 : 1000;
}

export function modbusOscCycleAction(
  kind: ConnectionKind,
  hasError: boolean,
  consecutiveFailures: number,
): ModbusOscCycleAction {
  if (!hasError) return 'append';
  if (kind !== 'cloud') return 'append';
  return consecutiveFailures >= CLOUD_MODBUS_OSC_MAX_CONSECUTIVE_FAILURES
    ? 'stop'
    : 'continue';
}
