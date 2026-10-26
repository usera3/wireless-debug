type ConsoleIconName = 'devices' | 'dashboard' | 'osc' | 'modbusOsc' | 'params' | 'bootloader' | 'connection' | 'debug';

const paths: Record<ConsoleIconName, string> = {
  devices: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  dashboard: 'M3 4h18v13H3z M8 21h8 M12 17v4 M5 11h3l2-4 3 7 2-4h4',
  osc: 'M2 12h4l3-8 4 16 3-12 2 4h4',
  modbusOsc: 'M2 9h4l3-5 4 10 3-6 3 3h3 M2 17h5l3-4 3 7 4-4h5',
  params: 'M4 6h7m4 0h5 M4 12h11m4 0h1 M4 18h3m4 0h9 M11 3v6 M15 9v6 M7 15v6',
  bootloader: 'M8 3v6h8V3 M5 3h14l2 2v16H3V3z M7 21v-7h10v7',
  connection: 'M8 3v5m8-5v5 M5 8h14v3a7 7 0 0 1-7 7v3 M8 8v4m8-4v4',
  debug: 'M8 8h8v9a4 4 0 0 1-8 0z M9 8V6a3 3 0 0 1 6 0v2 M4 11h4m8 0h4 M4 16h4m8 0h4 M12 8v12',
};

export function ConsoleIcon({ name }: { name: ConsoleIconName }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
