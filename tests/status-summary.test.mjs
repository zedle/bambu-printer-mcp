import assert from 'node:assert/strict';
import { test } from 'node:test';

const { statusDetails, hmsCode, printErrorCode } = await import('../dist/status-summary.js');

test('HMS and print_error codes use Bambu\'s dashed hex form', () => {
  assert.equal(hmsCode({ attr: 83952640, code: 196610 }), '0501-0400-0003-0002');
  assert.equal(hmsCode({ attr: 201326848, code: 131099 }), '0C00-0100-0002-001B');
  assert.equal(printErrorCode(0x0300400c), '0300-400C');
  assert.equal(printErrorCode(0), null);
});

test('status details keep what an agent needs from an H2C report', () => {
  const report = {
    gcode_state: 'RUNNING', mc_print_stage: '2', mc_print_sub_stage: 0, stg_cur: 39,
    subtask_name: 'keychain', task_id: '1343101504', print_type: 'cloud', print_error: 0,
    hms: [{ attr: 83952640, code: 196612 }],
    device: { plate: { cur_id: 'P0502' }, nozzle: { tar_id: 18, info: [
      { id: 0, type: 'HS01', diameter: 0.4, sn: '20D06A642910914' }, { id: 1, type: 'HH05', diameter: 0.4, sn: 'N/A' }] } },
    ams: { tray_now: '0', ams: [{ id: '0', humidity: '5', temp: '26.6', tray: [
      { id: '0', tray_type: 'PLA', tray_color: '161616FF', tray_sub_brands: '' }, { id: '1', tray_type: '' }] }] },
    vir_slot: [{ id: '254', tray_type: 'PLA', tray_color: '76D9F4FF' }, { id: '255', tray_type: '' }],
    lights_report: [{ node: 'chamber_light', mode: 'on' }], wifi_signal: '-53dBm',
    modules: Array.from({ length: 200 }, (_, i) => ({ name: `m${i}` })),
  };
  const details = statusDetails(report);
  assert.deepEqual(details.hms, ['0501-0400-0003-0004']);
  assert.equal(details.plate, 'P0502');
  assert.equal(details.printError, null);
  assert.deepEqual(details.nozzles, { mountedRackId: 18, info: [{ id: 0, type: 'HS01', diameter: 0.4, sn: '20D06A642910914' }, { id: 1, type: 'HH05', diameter: 0.4 }] });
  assert.deepEqual(details.ams, [{ id: '0', humidity: '5', temperature: '26.6', trays: [{ id: '0', type: 'PLA', colour: '#161616', name: undefined }, { id: '1', empty: true }] }]);
  assert.deepEqual(details.externalSpools, [{ id: '254', type: 'PLA', colour: '#76D9F4', name: undefined }, { id: '255', empty: true }]);
  assert.deepEqual(details.lights, { chamber_light: 'on' });
  assert.ok(JSON.stringify(details).length < 2000, 'module lists and internals stay out');
});
