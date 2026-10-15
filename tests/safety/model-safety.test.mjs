import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mockStatus } from './push-fixtures.mjs';

const { validatePrinterState } = await import('../../dist/safety/printer-state.js');
const models = await import('../../dist/safety/models.js');
const { normalizeBridgeAmsTrayValue } = await import('../../dist/ams-mapping.js');

const external = (model, extra = {}) => ({ model, nozzleDiameters: [], materials: ['PLA'], useAMS: false, ...extra });

test('single-nozzle printers on current firmware report their one external holder as 255', () => {
  for (const [name, model] of [['H2S', 'h2s'], ['P2S', 'p2s'], ['X1CMULTIAMS', 'x1c']]) {
    for (const amsMapping of [undefined, [254], [255]]) {
      assert.doesNotThrow(() => validatePrinterState(mockStatus(name), external(model, { amsMapping })), `${name} ${amsMapping}`);
    }
    const loaded = mockStatus(name, { vir_slot: [{ id: '255', tray_type: 'PETG' }] });
    assert.throws(() => validatePrinterState(loaded, external(model)), /material PETG in slot \d+ contradicts/);
  }
  // Older firmware reports only vt_tray (id 254).
  assert.doesNotThrow(() => validatePrinterState(mockStatus('P1PNOAMS'), external('p1p', { materials: ['PETG'] })));
  assert.doesNotThrow(() => validatePrinterState(mockStatus('A1'), external('a1', { amsMapping: [255] })));
});

test('dual-nozzle printers pick the holder the filament is mapped to', () => {
  // H2D with PLA on the left holder (254) and TPU on the right one (255).
  const status = mockStatus('H2DEXTSPOOLACTIVE');
  assert.doesNotThrow(() => validatePrinterState(status, external('h2d', { amsMapping: [254] })));
  assert.throws(() => validatePrinterState(status, external('h2d', { amsMapping: [255] })), /TPU in slot 255 contradicts/);
  assert.doesNotThrow(() => validatePrinterState(status, external('h2d', { materials: ['TPU'], amsMapping: [255] })));
  for (const [name, model] of [['H2D', 'h2d'], ['X2D', 'x2d']]) {
    assert.doesNotThrow(() => validatePrinterState(mockStatus(name), external(model, { amsMapping: [255] })), name);
    assert.doesNotThrow(() => validatePrinterState(mockStatus(name), external(model, { amsMapping: [254] })), name);
  }
  // The H2D Pro mock has TPU on its right holder.
  assert.doesNotThrow(() => validatePrinterState(mockStatus('H2DPRO'), external('h2dpro', { materials: ['TPU'], amsMapping: [255] })));
  // The H2C reports a 255 holder, but its right (rack) extruder is fed by the AMS only.
  assert.doesNotThrow(() => validatePrinterState(mockStatus('H2C'), external('h2c', { amsMapping: [254] })));
  assert.throws(() => validatePrinterState(mockStatus('H2C'), external('h2c', { amsMapping: [255] })), /no usable external spool holder 255/);
  // An AMS tray can't stand in for an external spool when AMS is off.
  assert.throws(() => validatePrinterState(mockStatus('H2D'), external('h2d', { amsMapping: [0] })), /external spool holder/);
});

test('external-spool jobs map each filament to its nozzle\'s holder', () => {
  const job = { materials: ['PLA', 'PETG', 'PLA'], usedFilamentPositions: [0, 1], filamentMap: [1, 2, 1] };
  assert.deepEqual(models.externalSpoolMapping('h2d', job), [254, 255, -1]);
  assert.deepEqual(models.externalSpoolMapping('x2d', job), [254, 255, -1]);
  assert.deepEqual(models.externalSpoolMapping('p1s', job), [254, 254, -1]);
  assert.throws(() => models.externalSpoolMapping('h2c', job), /right nozzle has no external spool holder/);
  assert.deepEqual(models.externalSpoolMapping('h2c', { ...job, usedFilamentPositions: [0, 2] }), [254, -1, 254]);
  // Without filament_map Studio's default puts every filament on the left extruder.
  assert.deepEqual(models.externalSpoolMapping('h2d', { ...job, filamentMap: undefined }), [254, 254, -1]);
});

test('tray values accept both external holders and only real AMS-HT units', () => {
  for (const value of [-1, 0, 15, 128, 135, 254, 255]) assert.equal(normalizeBridgeAmsTrayValue(value, 'ams'), value);
  for (const value of [16, 127, 136, 253, 256]) assert.throws(() => normalizeBridgeAmsTrayValue(value, 'ams'), /254\/255/);
});

test('every dual-nozzle model compares the sliced left nozzle with physical id 1', () => {
  for (const [name, model] of [['H2D', 'h2d'], ['H2DPRO', 'h2dpro'], ['H2C', 'h2c'], ['X2D', 'x2d']]) {
    // Right (id 0) 0.6, left (id 1) 0.4.
    const device = { ...mockStatus(name).raw.device, nozzle: { info: [{ id: 0, diameter: 0.6, type: 'HS01', stat: 0 }, { id: 1, diameter: 0.4, type: 'HS01', stat: 0 }] } };
    const status = mockStatus(name, { device });
    const job = nozzleDiameters => ({ model, nozzleDiameters, nozzleFlows: ['standard', 'standard'], materials: ['PLA'], useAMS: false, amsMapping: [254] });
    assert.doesNotThrow(() => validatePrinterState(status, job([0.4, 0.6])), name);
    assert.throws(() => validatePrinterState(status, job([0.6, 0.4])), /nozzle 1 diameter/, name);
    // A file that declares the identity map is compared that way.
    assert.doesNotThrow(() => validatePrinterState(status, { ...job([0.6, 0.4]), physicalExtruderMap: [0, 1] }), name);
  }
  assert.deepEqual(models.physicalExtruderMap('h2d'), [1, 0]);
  assert.deepEqual(models.physicalExtruderMap('p2s'), [0]);
  for (const bad of [[1, 1], [0], [2, 0]]) assert.throws(() => models.physicalExtruderMap('x2d', bad), /physical_extruder_map/);
});

test('only the extruders the used filaments run on are checked', () => {
  // Right (id 0) 0.4 standard; left (id 1) a 0.8 high-flow hotend the job never touches.
  const device = nozzles => ({ ...mockStatus('H2D').raw.device, nozzle: { info: nozzles } });
  const status = mockStatus('H2D', { device: device([{ id: 0, diameter: 0.4, type: 'HS01', stat: 0 }, { id: 1, diameter: 0.8, type: 'HH01', stat: 6 }]) });
  const job = extra => ({ model: 'h2d', nozzleDiameters: [0.4, 0.4], nozzleFlows: ['standard', 'standard'], materials: ['PLA', 'PETG'],
    usedFilamentPositions: [1], filamentMap: [1, 2], useAMS: false, amsMapping: [-1, 255], ...extra });
  assert.doesNotThrow(() => validatePrinterState(status, job()));
  // Once a used filament runs on the left extruder, its nozzle is compared and its abnormal state blocks.
  assert.throws(() => validatePrinterState(status, job({ usedFilamentPositions: [0, 1], amsMapping: [254, 255] })), /nozzle 1 diameter/);
  const abnormal = mockStatus('H2D', { device: device([{ id: 0, diameter: 0.4, type: 'HS01', stat: 0 }, { id: 1, diameter: 0.4, type: 'HS01', stat: 2 }]) });
  assert.throws(() => validatePrinterState(abnormal, job({ usedFilamentPositions: [0, 1], amsMapping: [254, 255] })), /nozzle 1 is reported abnormal/);
  assert.doesNotThrow(() => validatePrinterState(abnormal, job()));
});

test('the H2C right extruder accepts a matching rack hotend and blocks on a busy or full rack', () => {
  // Mock H2C: mounted 0.4 HS01 on both extruders; rack 16 (0.2 HS00), 17-19/21 (0.4/0.6 HS01).
  const job = (diameters, extra = {}) => ({ model: 'h2c', nozzleDiameters: diameters, nozzleFlows: ['standard', 'standard'], materials: ['PLA'],
    usedFilamentPositions: [0], filamentMap: [2], useAMS: true, amsMapping: [0], ...extra });
  const ams = { ...mockStatus('H2C').raw.ams, tray_exist_bits: '1', ams: [{ id: '0', info: '1023', tray: [{ id: '0', tray_type: 'PLA' }] }] };
  const status = (nozzle = {}) => mockStatus('H2C', { ams, device: { ...mockStatus('H2C').raw.device, nozzle: { ...mockStatus('H2C').raw.device.nozzle, ...nozzle } } });
  assert.doesNotThrow(() => validatePrinterState(status(), job([0.4, 0.4])));
  assert.doesNotThrow(() => validatePrinterState(status(), job([0.4, 0.6])), 'a 0.6 job is served from rack 18');
  assert.doesNotThrow(() => validatePrinterState(status(), job([0.4, 0.2])), 'a 0.2 job is served from rack 16');
  assert.throws(() => validatePrinterState(status(), job([0.4, 0.8])), /No mounted or rack hotend on the right nozzle matches/);
  assert.throws(() => validatePrinterState(status({ state: 0x111 }), job([0.4, 0.4])), /reading its hotend rack/);
  const full = mockStatus('H2C').raw.device.nozzle.info.concat([{ id: 20, diameter: 0.4, type: 'HS01', stat: 0 }]);
  assert.throws(() => validatePrinterState(status({ info: full }), job([0.4, 0.4])), /hotend rack are full/);
  // The left extruder has no rack: it must match its own mounted hotend.
  assert.throws(() => validatePrinterState(status(), job([0.6, 0.4], { filamentMap: [1], amsMapping: [254], useAMS: false })), /nozzle 1 diameter/);
});
