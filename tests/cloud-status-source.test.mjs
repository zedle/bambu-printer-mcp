import assert from 'node:assert/strict';
import { test } from 'node:test';

const { BambuImplementation } = await import('../dist/printers/bambu.js');

test('with cloud status on, status and safety reads come from the cloud reader and never open a LAN connection', async () => {
  const bambu = new BambuImplementation();
  bambu.getPrinter = async () => { throw new Error('LAN connection attempted'); };
  const reads = [];
  const raw = { gcode_state: 'RUNNING', nozzle_temper: 215, bed_temper: 60, subtask_name: 'case-v3', mc_percent: 42, print_error: 0, hms: [] };
  bambu.useCloudStatus(async serial => { reads.push(serial); return { connected: true, model: 'h2c', status: raw.gcode_state, serial, raw, observation: { source: 'cloud' } }; });

  const safety = await bambu.getSafetyStatus('192.0.2.1', '31BTEST', 'code');
  assert.equal(safety.observation.source, 'cloud');
  const display = await bambu.getStatus('192.0.2.1', '31BTEST', 'code');
  assert.equal(display.status, 'RUNNING');
  assert.equal(display.temperatures.nozzle.actual, 215);
  assert.equal(display.print.filename, 'case-v3');
  assert.equal(display.print.progress, 42);
  assert.deepEqual(reads, ['31BTEST', '31BTEST']);
});

test('a failed cloud read shows as a disconnected status, not a crash', async () => {
  const bambu = new BambuImplementation();
  bambu.useCloudStatus(async () => { throw new Error('bridge not signed in'); });
  const display = await bambu.getStatus('192.0.2.1', '31BTEST', 'code');
  assert.equal(display.connected, false);
  assert.match(display.error, /bridge not signed in/);
  await assert.rejects(bambu.getSafetyStatus('192.0.2.1', '31BTEST', 'code'), /bridge not signed in/);
});
