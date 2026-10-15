// Printer-free status fixtures built from ha-bambulab's recorded push_status payloads (MIT, see fixtures/push/NOTICE.txt).
import { readFileSync } from 'node:fs';

const PREFIX = { H2S: '093', P2S: '22E', X1CMULTIAMS: '00M', H2D: '094', H2DEXTSPOOLACTIVE: '094', H2DPRO: '239',
  H2C: '31B', X2D: '20P', A1: '039', P1PNOAMS: '01S' };

export function mockReport(name) {
  return JSON.parse(readFileSync(new URL(`../fixtures/push/MOCK-${name}.json`, import.meta.url), 'utf8')).pushall.print;
}

/** A fresh observed status for validatePrinterState: the mock's report, idle, with a serial that names its model. */
export function mockStatus(name, overrides = {}) {
  const serial = `${PREFIX[name]}MOCK${name}`;
  const raw = { ...mockReport(name), gcode_state: 'IDLE', print_error: 0, hms: [], modules: [{ name: 'ota', sn: serial }], ...overrides };
  return { connected: true, serial, raw, observation: { source: 'mqtt', requestedAt: Date.now(), receivedAt: Date.now(), identitySource: 'module-serial' } };
}
