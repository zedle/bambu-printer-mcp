import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mockReport, mockStatus } from './push-fixtures.mjs';

const { printStartGates, sdCardState } = await import('../../dist/safety/state-gates.js');
const { validatePrinterState } = await import('../../dist/safety/printer-state.js');

const MODELS = { A1: 'a1', H2C: 'h2c', H2D: 'h2d', H2DEXTSPOOLACTIVE: 'h2d', H2DPRO: 'h2dpro', H2S: 'h2s', P1PNOAMS: 'p1p', P2S: 'p2s', X1CMULTIAMS: 'x1c', X2D: 'x2d' };
const idle = (name, overrides = {}) => ({ ...mockReport(name), gcode_state: 'IDLE', print_error: 0, hms: [], ...overrides });

test('every recorded idle report passes Studio\'s printer-state checks', () => {
  for (const [name, model] of Object.entries(MODELS)) {
    assert.deepEqual(printStartGates(idle(name), { model, filamentCount: 4, trays: [0], timelapse: false }), [], name);
  }
});

test('storage state is read like Studio: aux bits 12-13 on new-protocol printers, else home_flag bits 8-9, else sdcard', () => {
  assert.equal(sdCardState(idle('H2D')), 1);
  assert.equal(sdCardState(idle('H2C')), 0);
  assert.equal(sdCardState(idle('A1')), 1);
  assert.equal(sdCardState({ sdcard: false }), 0);
  assert.equal(sdCardState({ home_flag: 0x300 }), 3);
  assert.equal(sdCardState({}), undefined);
});

test('Studio\'s blocking printer states refuse a print start', () => {
  for (const [label, name, overrides, model, pattern, extra] of [
    ['forced firmware update (cfg bit 2)', 'H2D', { cfg: '3C5FDADD' }, 'h2d', /firmware must be updated/],
    ['forced firmware update (legacy upgrade_state)', 'A1', { upgrade_state: { force_upgrade: true } }, 'a1', /firmware must be updated/],
    ['module consistency update', 'A1', { upgrade_state: { consistency_request: true } }, 'a1', /consistency update/],
    ['laser mode', 'H2D', { device: { ...mockReport('H2D').device, type: 16 } }, 'h2d', /not in FDM mode/],
    ['firmware update running', 'H2D', { upgrade_state: { status: 'FLASHING', dis_state: 2 } }, 'h2d', /updating its firmware/],
    ['firmware update running (old firmware)', 'A1', { upgrade_state: { status: 'DOWNLOADING' } }, 'a1', /updating its firmware/],
    ['AMS filament change', 'X1CMULTIAMS', { ams_status: 0x0103 }, 'x1c', /loading or unloading/],
    ['cold pull', 'H2D', { ams_status: 0x0700 }, 'h2d', /cold pull/],
    ['AMS setting up', 'H2D', { ams: { ...mockReport('H2D').ams, cali_stat: 2 } }, 'h2d', /AMS is setting up/],
    ['no SD card where the model needs one', 'A1', { home_flag: 863847839 & ~0x300, sdcard: false }, 'a1', /can't print without one/],
    ['LAN mode without storage or eMMC', 'H2C', { device: { ...mockReport('H2C').device, connection_type: 'lan' } }, 'h2c', /LAN mode and reports no SD card/],
    ['LAN mode with a read-only card', 'H2D', { aux: '2003004', device: { ...mockReport('H2D').device, connection_type: 'lan' } }, 'h2d', /read-only/],
    ['too many filaments for the firmware', 'A1', {}, 'a1', /at most 16/, { filamentCount: 17 }],
  ]) {
    assert.throws(() => printStartGates(idle(name, overrides), { model, filamentCount: 4, ...extra }), pattern, label);
  }
  // LAN mode with eMMC (fun2 bit 0, the X2D) prints without a card; cloud mode doesn't need one on the H2C.
  assert.deepEqual(printStartGates(idle('X2D', { device: { ...mockReport('X2D').device, connection_type: 'lan' } }), { model: 'x2d' }), []);
  assert.deepEqual(printStartGates(idle('H2C', { device: { ...mockReport('H2C').device, connection_type: 'cloud' } }), { model: 'h2c' }), []);
  // The X1 and H2 series have no filament limit unless the firmware sets one.
  assert.deepEqual(printStartGates(idle('X1CMULTIAMS'), { model: 'x1c', filamentCount: 24 }), []);
  assert.throws(() => printStartGates(idle('H2D', { flag3: 1 << 17 }), { model: 'h2d', filamentCount: 33 }), /at most 32/);
});

test('Studio\'s printer-state warnings are listed, not blocking', () => {
  assert.deepEqual(printStartGates(idle('H2D', { ams_status: 0x0200 }), { model: 'h2d' }), ['the AMS is reading filament RFID tags; a tray\'s reported material may still change']);
  // Remote drying printers (fun2 bit 5) report a drying unit in info bits 4-7.
  const drying = idle('P2S', { fun2: '21', ams: { ...mockReport('P2S').ams, ams: mockReport('P2S').ams.ams.map(unit => ({ ...unit, info: '1023' })) } });
  assert.match(printStartGates(drying, { model: 'p2s', trays: [1] }).join(), /AMS 0 is drying/);
  assert.deepEqual(printStartGates(drying, { model: 'p2s', trays: [254] }), []);
  assert.match(printStartGates(idle('H2C'), { model: 'h2c', timelapse: true }).join(), /no SD card, so none will be recorded/);
  assert.deepEqual(printStartGates(idle('H2D'), { model: 'h2d', timelapse: true }), []);
  const lowStorage = idle('X2D', { fun: '10000000', device: { ...mockReport('X2D').device, cam: { tl_internal_free_kb: 1000, tl_internal_total_kb: 962560, tl_external_free_kb: 0, tl_external_total_kb: 0 } } });
  assert.deepEqual(printStartGates(lowStorage, { model: 'x2d', timelapse: true }), ['internal timelapse storage has less than 20 MB free; the timelapse may not save']);
  assert.deepEqual(printStartGates(idle('H2D'), { model: 'h2d', maxChamberTemperature: 45 }), ['this job heats the chamber; close the door if it isn\'t closed']);
  assert.deepEqual(printStartGates(idle('H2D'), { model: 'h2d', maxChamberTemperature: 35 }), []);
});

test('the gates apply to print starts only, through validatePrinterState', () => {
  const status = mockStatus('H2D', { ams_status: 0x0100 });
  const job = { model: 'h2d', nozzleDiameters: [], materials: ['PLA'], usedFilamentPositions: [0], useAMS: false, verifyMaterials: false };
  assert.doesNotThrow(() => validatePrinterState(status, job));
  assert.throws(() => validatePrinterState(status, { ...job, printStart: true }), /loading or unloading/);
  assert.doesNotThrow(() => validatePrinterState(status, { ...job, printStart: true, requireIdle: false }), 'resume keeps its own rules');
  const warned = validatePrinterState(mockStatus('H2D', { ams_status: 0x0200 }), { ...job, printStart: true });
  assert.ok(warned.hmsWarnings.some(warning => /RFID/.test(warning)));
});

test('a present tray with no reported filament type is a warning: the declared material is unverified', () => {
  const job = { model: 'h2d', nozzleDiameters: [], materials: ['PETG'], usedFilamentPositions: [0], useAMS: true, amsMapping: [0] };
  const raw = mockReport('H2D');
  const unset = { ...raw.ams, ams: raw.ams.ams.map(unit => unit.id === '0' ? { ...unit, tray: unit.tray.map(tray => tray.id === '0' ? { id: '0' } : tray) } : unit) };
  const status = mockStatus('H2D', { ams: unset });
  const { hmsWarnings } = validatePrinterState(status, job);
  assert.ok(hmsWarnings.includes('AMS slot 0 reports no filament type; PETG is as declared, not as reported'), JSON.stringify(hmsWarnings));
});
