import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mockStatus } from './push-fixtures.mjs';

const { validatePrinterState } = await import('../../dist/safety/printer-state.js');
const models = await import('../../dist/safety/models.js');
const mapping = await import('../../dist/ams-mapping.js');
const { normalizeBridgeAmsTrayValue } = mapping;

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
  const right = { filamentMap: [2] };
  assert.throws(() => validatePrinterState(status, external('h2d', { amsMapping: [255], ...right })), /TPU in slot 255 contradicts/);
  assert.doesNotThrow(() => validatePrinterState(status, external('h2d', { materials: ['TPU'], amsMapping: [255], ...right })));
  for (const [name, model] of [['H2D', 'h2d'], ['X2D', 'x2d']]) {
    assert.doesNotThrow(() => validatePrinterState(mockStatus(name), external(model, { amsMapping: [255], ...right })), name);
    assert.doesNotThrow(() => validatePrinterState(mockStatus(name), external(model, { amsMapping: [254] })), name);
  }
  // The H2D Pro mock has TPU on its right holder.
  assert.doesNotThrow(() => validatePrinterState(mockStatus('H2DPRO'), external('h2dpro', { materials: ['TPU'], amsMapping: [255], ...right })));
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
    const job = nozzleDiameters => ({ model, nozzleDiameters, nozzleFlows: ['standard', 'standard'], materials: ['PLA'], useAMS: false, amsMapping: [254], filamentMap: [1] });
    assert.doesNotThrow(() => validatePrinterState(status, job([0.4, 0.6])), name);
    assert.throws(() => validatePrinterState(status, job([0.6, 0.4])), /nozzle 1 diameter/, name);
    // A file that declares the identity map is compared that way.
    assert.doesNotThrow(() => validatePrinterState(status, { ...job([0.6, 0.4]), physicalExtruderMap: [0, 1], filamentMap: [2] }), name);
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

test('the H2C rack is matched against every right-side hotend the sliced plan uses', () => {
  const job = (nozzles, extra = {}) => ({ model: 'h2c', nozzleDiameters: [0.4, 0.4], nozzleFlows: ['standard', 'standard'], materials: ['PLA'],
    usedFilamentPositions: [0], filamentMap: [2], useAMS: true, amsMapping: [0],
    nozzlePlan: { nozzles, filamentNozzles: [nozzles[0]?.id], dynamicNozzleMap: false }, ...extra });
  const ams = { ...mockStatus('H2C').raw.ams, tray_exist_bits: '1', ams: [{ id: '0', info: '1023', tray: [{ id: '0', tray_type: 'PLA' }] }] };
  const status = (info) => mockStatus('H2C', { ams, ...(info ? { device: { ...mockStatus('H2C').raw.device, nozzle: { ...mockStatus('H2C').raw.device.nozzle, info } } } : {}) });
  const right = (id, diameter = 0.4, flow = 'standard') => ({ id, extruder: 2, diameter, flow });
  // Mock H2C right side: mounted 0.4 + rack 0.4 x3, 0.6, 0.2 (all Standard).
  assert.deepEqual(validatePrinterState(status(), job([right(1), right(2), right(3)])).hmsWarnings, []);
  // Five 0.4 hotends planned, four fitted: Studio warns (CheckWarningRackStatus) and the printer reuses one.
  assert.match(validatePrinterState(status(), job([1, 2, 3, 4, 5].map(id => right(id)))).hmsWarnings.join(), /plans 5 right-side 0.4 mm Standard hotends, but the printer has 4/);
  // A planned High Flow hotend the rack doesn't have is refused, with Studio's advice.
  assert.throws(() => validatePrinterState(status(), job([right(1), right(2, 0.4, 'high_flow')])), /No mounted or rack hotend on the right nozzle matches the job \(0.4 mm High Flow\)\. Re-slice for the hotends the printer has/);
  const uncalibrated = mockStatus('H2C', { ams, device: { ...mockStatus('H2C').raw.device, holder: { ...mockStatus('H2C').raw.device.holder, info: 0 } } });
  assert.throws(() => validatePrinterState(uncalibrated, job([right(1, 0.8)])), /Calibrate the hotend rack/);
  const unknown = mockStatus('H2C').raw.device.nozzle.info.map(nozzle => nozzle.id === 21 ? { ...nozzle, stat: 4 } : nozzle);
  assert.throws(() => validatePrinterState(status(unknown), job([right(1, 0.8)])), /Refresh the hotend information/);
  // An unknown hotend is not counted as a match.
  assert.match(validatePrinterState(status(unknown), job([1, 2, 3, 4].map(id => right(id)))).hmsWarnings.join(), /plans 4 right-side 0.4 mm Standard hotends, but the printer has 3/);
});

test('AMS-HT units are addressed by unit id with presence from the top-level bits 16+', () => {
  // The AMS-HT units are bound to the right extruder (info 2004), so the filament is sliced for it (filament_map 2).
  const ams = (materials, extra = {}) => ({ model: 'h2d', nozzleDiameters: [], materials, useAMS: true, filamentMap: [2], ...extra });
  // H2D with AMS-HT units 128 (PLA) and 129 (PETG), both present (bits 16 and 17 of 0x3bbed).
  const h2d = mockStatus('H2DEXTSPOOLACTIVE');
  assert.doesNotThrow(() => validatePrinterState(h2d, ams(['PLA'], { amsMapping: [128] })));
  assert.doesNotThrow(() => validatePrinterState(h2d, ams(['PETG'], { amsMapping: [129] })));
  assert.throws(() => validatePrinterState(h2d, ams(['PLA'], { amsMapping: [129] })), /PETG in slot 129 contradicts/);
  assert.throws(() => validatePrinterState(mockStatus('H2DEXTSPOOLACTIVE', { ams: { ...h2d.raw.ams, tray_exist_bits: '1bbed' } }), ams(['PETG'], { amsMapping: [129] })), /slot 129 is reported empty/);
  assert.throws(() => validatePrinterState(h2d, ams(['PLA'], { amsMapping: [130] })), /slot 130 is not present/);
  for (const index of [16, 136, 253]) assert.throws(() => validatePrinterState(h2d, ams(['PLA'], { amsMapping: [index] })), /not an AMS tray|mapping|external/);
  // X1C with three AMS and one AMS-HT (PA-CF): bit 16 of 0x10eff.
  assert.doesNotThrow(() => validatePrinterState(mockStatus('X1CMULTIAMS'), { ...ams(['PA'], { amsMapping: [128] }), model: 'x1c' }));
});

test('tray mappings use Studio\'s encoding on every transport', () => {
  const { studioTrayMapping } = mapping;
  assert.deepEqual(studioTrayMapping([0, 7, 128, 129, 254, 255, -1], false), {
    v0: [0, 7, 128, 129, -1, -1, -1], trays: [0, 7, 128, 129, 254, 255, -1],
    v1: [{ ams_id: 0, slot_id: 0 }, { ams_id: 1, slot_id: 3 }, { ams_id: 128, slot_id: 0 }, { ams_id: 129, slot_id: 0 },
      { ams_id: 254, slot_id: 0 }, { ams_id: 255, slot_id: 0 }, { ams_id: 255, slot_id: 255 }],
  });
  // A single-extruder printer's one holder is 255 to Studio.
  assert.deepEqual(studioTrayMapping([254, 3], true).v1, [{ ams_id: 255, slot_id: 0 }, { ams_id: 0, slot_id: 3 }]);
  assert.deepEqual(studioTrayMapping([254, 3], true).trays, [255, 3]);
});

test('a tray must be able to feed the nozzle its filament is sliced for', () => {
  // H2D mock: AMS 0 (info 2103) feeds the left extruder, AMS 1 (info 2003) the right one.
  const job = (amsMapping, filamentMap, extra = {}) => ({ model: 'h2d', nozzleDiameters: [], materials: ['PLA'], useAMS: true, amsMapping, filamentMap, ...extra });
  const h2d = mockStatus('H2D');
  assert.doesNotThrow(() => validatePrinterState(h2d, job([1], [1])));
  assert.doesNotThrow(() => validatePrinterState(h2d, job([4], [2])));
  assert.throws(() => validatePrinterState(h2d, job([1], [2])), /AMS 0 can't feed the H2D's right nozzle.*1807-8006/);
  assert.throws(() => validatePrinterState(h2d, job([4], [1])), /AMS 1 can't feed the H2D's left nozzle/);
  // External holders: 254 left, 255 right.
  assert.throws(() => validatePrinterState(h2d, { ...job([254], [2]), useAMS: false }), /External spool 254 can't feed the H2D's right nozzle/);
  // H2C: its AMS feeds only the right (rack) extruder; the left one only from the external spool.
  const h2c = mockStatus('H2C', { ams: { tray_exist_bits: '1', tray_now: '255', ams: [{ id: '0', info: '1023', tray: [{ id: '0', tray_type: 'PLA' }] }] } });
  assert.doesNotThrow(() => validatePrinterState(h2c, { ...job([0], [2]), model: 'h2c' }));
  assert.throws(() => validatePrinterState(h2c, { ...job([0], [1]), model: 'h2c' }), /AMS 0 can't feed the H2C's left nozzle/);
  // X2D: the AMS is bound to the left extruder (info 11002103); a Filament Track Switch (0xE) feeds both only when fitted.
  const x2d = mockStatus('X2D');
  assert.doesNotThrow(() => validatePrinterState(x2d, { ...job([0], [1]), model: 'x2d' }));
  assert.throws(() => validatePrinterState(x2d, { ...job([0], [2]), model: 'x2d' }), /can't feed the X2D's right nozzle/);
  const switched = units => mockStatus('X2D', { ams: { ...x2d.raw.ams, ams: x2d.raw.ams.ams.map(unit => ({ ...unit, info: '11000E03' })) }, device: { ...x2d.raw.device, ...units } });
  assert.doesNotThrow(() => validatePrinterState(switched({ fila_switch: { info: 1 } }), { ...job([0], [2]), model: 'x2d' }));
  assert.throws(() => validatePrinterState(switched({ fila_switch: null }), { ...job([0], [2]), model: 'x2d' }), /feeds no nozzle/);
  // Single-nozzle printers have nothing to bind.
  assert.doesNotThrow(() => validatePrinterState(mockStatus('P2S'), { ...job([0], [1]), model: 'p2s' }));
});

test('print options follow Studio: bed strings, unsupported plates and calibration defaults per model', async () => {
  const options = await import('../../dist/printers/print-options.js');
  for (const [value, expected] of [['textured_plate', 'textured_plate'], ['Textured PEI Plate', 'textured_plate'], ['engineering_plate', 'eng_plate'], ['Engineering Plate', 'eng_plate'],
    ['eng_plate', 'eng_plate'], ['hot_plate', 'hot_plate'], ['High Temp Plate', 'hot_plate'], ['Smooth PEI Plate', 'hot_plate'], ['cool_plate', 'cool_plate'], ['pc_plate', 'cool_plate'],
    ['supertack_plate', 'supertack_plate'], ['Cool Plate SuperTack', 'supertack_plate'], ['Supertack Plate', 'supertack_plate']]) {
    assert.equal(options.studioBedType(value), expected, value);
  }
  assert.equal(options.studioBedType('mystery'), undefined);
  assert.throws(() => options.assertBedSupported('h2c', 'hot_plate'), /not_support_bed_type/);
  assert.throws(() => options.assertBedSupported('a1mini', 'eng_plate'), /not_support_bed_type/);
  assert.doesNotThrow(() => options.assertBedSupported('x1c', 'cool_plate'));
  // Dual-nozzle job on both nozzles: auto everywhere, nozzle-offset calibration auto.
  assert.deepEqual(options.studioPrintOptions('h2d', 2), { bedLeveling: false, autoBedLeveling: 2, flowCalibration: false, autoFlowCalibration: 2, autoOffsetCalibration: 2, vibrationCalibration: false, layerInspect: true });
  assert.equal(options.studioPrintOptions('h2c', 1).autoOffsetCalibration, 0);
  // X1C offers on/off only; the P1S has no flow calibration.
  assert.deepEqual(options.studioPrintOptions('x1c', 1), { bedLeveling: true, autoBedLeveling: 1, flowCalibration: true, autoFlowCalibration: 1, autoOffsetCalibration: 0, vibrationCalibration: false, layerInspect: true });
  assert.deepEqual(options.studioPrintOptions('p1s', 1, { flowCalibration: true }).autoFlowCalibration, 0);
  assert.equal(options.studioPrintOptions('x1c', 1, { bedLeveling: 'auto' }).autoBedLeveling, 1);
  assert.deepEqual([options.studioPrintOptions('p2s', 1, { bedLeveling: 'off' }).bedLeveling, options.studioPrintOptions('p2s', 1, { bedLeveling: 'off' }).autoBedLeveling], [false, 0]);
  assert.throws(() => options.studioPrintOptions('p2s', 1, { bedLeveling: 'sometimes' }), /bed_leveling/);
  assert.equal(options.usedExtruderCount('h2d', { usedFilamentPositions: [0, 1], filamentMap: [1, 2] }), 2);
  assert.equal(options.usedExtruderCount('h2d', { usedFilamentPositions: [0, 1] }), 1);
});

test('control commands take the form Studio picks for each printer', async () => {
  const control = await import('../../dist/printers/control-commands.js');
  const protocol = name => control.controlProtocol(mockStatus(name).raw, name.toLowerCase());
  const print = command => JSON.parse(command.messageJson).print;
  // Bed: set_bed_temp only where fun bit 39 is set (H2S, X2D, P2S); the X1C and this H2D report get M140.
  const { sequence_id: _ignored, ...bed } = print(control.temperatureCommand(protocol('H2S'), 'bed', 60));
  assert.deepEqual(bed, { command: 'set_bed_temp', temp: 60 });
  for (const name of ['X1CMULTIAMS', 'H2D', 'A1', 'P1PNOAMS']) {
    const command = control.temperatureCommand(protocol(name), 'bed', 60);
    assert.deepEqual([print(command).command, print(command).param], ['gcode_line', 'M140 S60\n'], name);
  }
  // Nozzle: M104 S (no T) on one nozzle, set_nozzle_temp with the extruder on two.
  assert.equal(print(control.temperatureCommand(protocol('P2S'), 'nozzle', 220)).param, 'M104 S220\n');
  assert.deepEqual([print(control.temperatureCommand(protocol('H2C'), 'nozzle', 220, 1)).command, print(control.temperatureCommand(protocol('H2C'), 'nozzle', 220, 1)).extruder_index], ['set_nozzle_temp', 1]);
  assert.equal(control.temperatureCommand(protocol('H2C'), 'nozzle', 220, 0).qos, 1);
  assert.throws(() => control.temperatureCommand(protocol('H2D'), 'nozzle', 220), /left or right/);
  assert.throws(() => control.temperatureCommand(protocol('A1'), 'nozzle', 220, 1), /one nozzle/);
  assert.deepEqual([print(control.temperatureCommand(protocol('H2D'), 'chamber', 45)).command, print(control.temperatureCommand(protocol('H2D'), 'chamber', 45)).ctt_val], ['set_ctt', 45]);
  // Fans: set_fan on new-protocol printers with an airduct, else M106 S0-255 in 10 % steps.
  assert.deepEqual([print(control.fanCommand(protocol('X2D'), 'right_auxiliary', 54)).fan_index, print(control.fanCommand(protocol('X2D'), 'right_auxiliary', 54)).speed], [10, 50]);
  assert.equal(print(control.fanCommand(protocol('X1CMULTIAMS'), 'part', 55)).param, 'M106 P1 S153 \n');
  assert.equal(print(control.fanCommand(protocol('A1'), 'aux', 100)).param, 'M106 P2 S255 \n');
  assert.throws(() => control.fanCommand(protocol('A1'), 'right_auxiliary', 50), /no right auxiliary/);
  // RFID: ams_get_rfid with the new (AMS) protocol, else M620 R<ams*4+slot>.
  assert.equal(print(control.rfidCommand(protocol('P1PNOAMS'), 1, 2)).command, 'ams_get_rfid');
  assert.equal(print(control.rfidCommand(protocol('A1'), 1, 2)).param, 'M620 R6 \n');
  assert.equal(print(control.rfidCommand(protocol('H2D'), 128, 0)).command, 'ams_get_rfid');
  // Studio refuses an RFID read while filament is loaded to the toolhead the AMS feeds.
  assert.throws(() => control.assertNoFilamentAtToolhead(mockStatus('H2D').raw, protocol('H2D'), 'h2d', 1), /loaded to the toolhead/); // AMS 1 -> right, info 79 has bit 1
  assert.doesNotThrow(() => control.assertNoFilamentAtToolhead(mockStatus('H2D').raw, protocol('H2D'), 'h2d', 0)); // AMS 0 -> left, info 8
  assert.throws(() => control.assertNoFilamentAtToolhead(mockStatus('P1PNOAMS').raw, protocol('A1'), 'p1p', 0), /loaded/); // hw_switch_state 1
  assert.doesNotThrow(() => control.assertNoFilamentAtToolhead(mockStatus('A1').raw, protocol('A1'), 'a1', 0));
  // Without a report the model decides.
  assert.equal(print(control.temperatureCommand(control.controlProtocol(undefined, 'x2d'), 'bed', 0)).command, 'set_bed_temp');
  assert.equal(print(control.temperatureCommand(control.controlProtocol(undefined, 'p1s'), 'bed', 0)).param, 'M140 S0\n');
});

test('Studio\'s filament prohibitions block the job', async () => {
  const rules = await import('../../dist/safety/filament-rules.js');
  const blocked = check => rules.filamentProhibition({ model: 'p1s', external: false, ...check });
  assert.match(blocked({ type: 'TPU' }), /TPU is not supported by AMS/);
  assert.equal(blocked({ type: 'TPU', external: true }), undefined);
  assert.equal(blocked({ type: 'TPU-AMS' }), undefined);
  assert.match(blocked({ type: 'PET-CF', filamentId: 'GFT01' }), /Bambu Lab PET-CF/);
  assert.equal(blocked({ type: 'PET-CF', filamentId: 'GFT98' }), undefined, 'a generic PET-CF is allowed in the AMS');
  // E3D high-flow hotends on the P1P, P1S and X1C.
  assert.match(blocked({ type: 'PPS-CF', external: true, nozzleFlow: 'high_flow' }), /E3D high-flow/);
  assert.match(blocked({ model: 'x1c', type: 'PA', name: 'Bambu PA6-GF', external: true, nozzleFlow: 'e3dhighflow' }), /E3D high-flow/);
  assert.equal(blocked({ model: 'x1e', type: 'PPS-CF', external: true, nozzleFlow: 'high_flow' }), undefined);
  assert.equal(blocked({ type: 'PPS-CF', external: true, nozzleFlow: 'standard' }), undefined);
  // H2D/H2D Pro TPU high-flow nozzle: only Bambu's TPU ids; Bambu TPU 85A not on 0.4 Standard/High Flow.
  assert.match(blocked({ model: 'h2d', type: 'PLA', filamentId: 'GFA00', external: true, nozzleFlow: 'tpuhighflow' }), /TPU high-flow nozzle/);
  assert.equal(blocked({ model: 'h2d', type: 'TPU', filamentId: 'GFU01', external: true, nozzleFlow: 'tpuhighflow' }), undefined);
  assert.match(blocked({ model: 'h2dpro', type: 'TPU', name: 'Bambu TPU 85A', external: true, nozzleFlow: 'standard', nozzleDiameter: 0.4 }), /TPU 85A/);
  assert.equal(blocked({ model: 'h2dpro', type: 'TPU', name: 'Bambu TPU 85A', external: true, nozzleFlow: 'standard', nozzleDiameter: 0.6 }), undefined);

  // Through the print gate: TPU mapped to an AMS slot is refused, from the tray or the declared material.
  const status = mockStatus('P2S', { ams: { tray_exist_bits: 'f', tray_now: '255', ams: [{ id: '0', info: '1003', tray: [{ id: '0', tray_type: 'TPU' }, { id: '1', tray_type: '' }] }] } });
  assert.throws(() => validatePrinterState(status, { model: 'p2s', nozzleDiameters: [], materials: ['TPU'], useAMS: true, amsMapping: [0] }), /TPU is not supported by AMS/);
  assert.throws(() => validatePrinterState(status, { model: 'p2s', nozzleDiameters: [], materials: ['TPU'], filamentTypes: ['TPU'], useAMS: true, amsMapping: [1] }), /TPU is not supported by AMS/);
  assert.doesNotThrow(() => validatePrinterState(status, { model: 'p2s', nozzleDiameters: [], materials: ['TPU'], filamentTypes: ['TPU-AMS'], useAMS: true, amsMapping: [1] }));
  assert.doesNotThrow(() => validatePrinterState(mockStatus('P2S', { vir_slot: [{ id: '255', tray_type: 'TPU' }] }), { model: 'p2s', nozzleDiameters: [], materials: ['TPU'], useAMS: false }));
  // TPU on the H2D: automatic flow calibration is prohibited, so it defaults off.
  const options = await import('../../dist/printers/print-options.js');
  assert.equal(options.studioPrintOptions('h2d', 1, {}, ['TPU']).autoFlowCalibration, 0);
  assert.equal(options.studioPrintOptions('h2d', 1, { flowCalibration: true }, ['TPU']).autoFlowCalibration, 1);
  assert.throws(() => options.studioPrintOptions('h2dpro', 1, { flowCalibration: 'auto' }, ['TPU']), /not supported for TPU/);
  assert.equal(options.studioPrintOptions('h2s', 1, {}, ['TPU']).autoFlowCalibration, 2);
});

test('Studio printer_type codes identify models; cloud model ids name no printer', () => {
  for (const [code, model] of [['N1', 'a1mini'], ['A1M', 'a1mini'], ['N7', 'p2s'], ['N7-V2', 'p2s'], ['O1D-V2', 'h2d'], ['3DPrinter-X1-Carbon', 'x1c'], ['3DPrinter-X1', 'x1'], ['BL-P001', 'x1c'], ['C13', 'x1e']]) {
    const raw = { gcode_state: 'IDLE', print_error: 0, hms: [], printer_type: code };
    const status = { connected: true, serial: '', raw, observation: { source: 'mqtt', requestedAt: Date.now(), receivedAt: Date.now() } };
    assert.doesNotThrow(() => validatePrinterState(status, { model, nozzleDiameters: [], verifyMaterials: false }), code);
  }
  // The recorded reports' cloud model ids are ignored; the serial prefix identifies the printer.
  for (const [name, model] of [['H2C', 'h2c'], ['P2S', 'p2s'], ['X2D', 'x2d']]) {
    assert.doesNotThrow(() => validatePrinterState(mockStatus(name), { model, nozzleDiameters: [], verifyMaterials: false }), name);
  }
  assert.equal(models.ftpFolder('a1mini'), 'sdcard/');
  assert.equal(models.ftpFolder('h2d'), '');
});

test('P1 and X1 build height is Studio\'s printable_height 250', async () => {
  const { MACHINE_LIMITS } = await import('../../dist/safety/limits.js');
  for (const model of ['p1p', 'p1s', 'x1', 'x1c', 'x1e']) assert.equal(MACHINE_LIMITS[model].volume[2], 250, model);
});

test('airduct modes come from the printer\'s own mode list, as in Studio\'s fan panel', async () => {
  const control = await import('../../dist/printers/control-commands.js');
  const print = command => JSON.parse(command.messageJson).print;
  // H2C lists cooling (0), heating (1) and exhaust (2, hidden by Studio): two selectable modes.
  const h2c = mockStatus('H2C').raw;
  assert.deepEqual([print(control.airductCommand(h2c, 'h2c', 'heating')).modeId, print(control.airductCommand(h2c, 'h2c', 'heating')).submode], [1, -1]);
  assert.equal(print(control.airductCommand(h2c, 'h2c', 'cooling', true)).submode, 1);
  assert.throws(() => control.airductCommand(h2c, 'h2c', 'full_cooling'), /offers cooling, heating, not full_cooling/);
  // Printers without an airduct refuse it; an unknown mode is refused before anything is sent.
  assert.throws(() => control.airductCommand(mockStatus('X1CMULTIAMS').raw, 'x1c', 'cooling'), /no switchable airduct/);
  assert.throws(() => control.airductCommand(h2c, 'h2c', 'exhaust'), /must be one of/);
  // A full-cooling mode (3) is selectable where the printer lists it.
  const listed = { device: { airduct: { modeList: [{ modeId: 0 }, { modeId: 1 }, { modeId: 3 }] } } };
  assert.equal(print(control.airductCommand(listed, 'p2s', 'full_cooling')).modeId, 3);
});

test('two-nozzle jobs carry Studio\'s nozzles_info', async () => {
  const options = await import('../../dist/printers/print-options.js');
  assert.deepEqual(JSON.parse(options.studioNozzlesInfo({ nozzleDiameters: [0.4, 0.6], nozzleFlows: ['high_flow', 'standard'] })), [
    { id: 1, type: null, flowSize: 'high_flow', diameter: 0.4 }, { id: 0, type: null, flowSize: 'standard_flow', diameter: 0.6 },
  ]);
  assert.equal(options.studioNozzlesInfo({ nozzleDiameters: [0.4] }), '');
});

test('a Hybrid right extruder needs a matching rack hotend for every flow it plans', () => {
  const ams = { ...mockStatus('H2C').raw.ams, tray_exist_bits: '3', ams: [{ id: '0', info: '1023', tray: [{ id: '0', tray_type: 'PLA' }, { id: '1', tray_type: 'PLA' }] }] };
  const plan = { nozzles: [{ id: 1, extruder: 2, diameter: 0.4, flow: 'standard' }, { id: 4, extruder: 2, diameter: 0.4, flow: 'high_flow' }], filamentNozzles: [1, 4], dynamicNozzleMap: false };
  const job = (extra = {}) => ({ model: 'h2c', nozzleDiameters: [0.4, 0.4], nozzleFlows: ['standard', 'hybrid'], materials: ['PLA', 'PLA'],
    usedFilamentPositions: [0, 1], filamentMap: [2, 2], useAMS: true, amsMapping: [0, 1], nozzlePlan: plan, ...extra });
  const withHighFlow = mockStatus('H2C').raw.device.nozzle.info.map(nozzle => nozzle.id === 21 ? { ...nozzle, type: 'HH01' } : nozzle);
  const status = info => mockStatus('H2C', { ams, ...(info ? { device: { ...mockStatus('H2C').raw.device, nozzle: { ...mockStatus('H2C').raw.device.nozzle, info } } } : {}) });
  assert.doesNotThrow(() => validatePrinterState(status(withHighFlow), job()));
  // The mock's rack is all Standard: the planned High Flow hotend isn't there.
  assert.throws(() => validatePrinterState(status(), job()), /No mounted or rack hotend on the right nozzle matches the job \(0.4 mm High Flow\)/);
  assert.throws(() => validatePrinterState(status(withHighFlow), job({ nozzlePlan: undefined })), /Hybrid but does not say which hotends/);
  // Only the rack extruder can mix flows.
  assert.throws(() => validatePrinterState(status(withHighFlow), job({ nozzleFlows: ['hybrid', 'standard'], filamentMap: [1, 2] })), /only an extruder with a hotend rack/);
});
