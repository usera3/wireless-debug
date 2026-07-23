import type { ConnectionTarget } from './connectionTarget';

type ConnectionKind = ConnectionTarget['kind'];
export type ModbusOscCycleAction = 'append' | 'stop';

export function modbusOscResponseTimeoutMs(kind: ConnectionKind): number {
  return kind === 'cloud' ? 2800 : 1000;
}

export function shouldStopModbusOscOnError(kind: ConnectionKind): boolean {
  return kind === 'cloud';
}

export function modbusOscCycleAction(
  kind: ConnectionKind,
  hasError: boolean,
): ModbusOscCycleAction {
  return hasError && shouldStopModbusOscOnError(kind) ? 'stop' : 'append';
}
