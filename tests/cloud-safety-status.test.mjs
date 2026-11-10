import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mockReport } from './safety/push-fixtures.mjs';

const { BambuNetworkBridge } = await import('../dist/bambu-network-bridge.js');
const safety = await import('../dist/safety/printer-state.js');

const SERIAL = '31BMOCKH2C';

// A bridge whose plug-in is stubbed: the printer answers a cloud pushall with `reply(serial)` as on_message events.
function stubBridge(reply) {
  const bridge = new BambuNetworkBridge();
  const sent = [];
  let queued = [];
  bridge.ensurePrinterChannel = async () => {};
  bridge.sendPrinterMessage = async (devId, msg) => {
    sent.push(JSON.parse(msg));
    if (JSON.parse(msg).pushing?.command === 'pushall') queued.push(...reply(devId));
    return 0;
  };
  bridge.request = async (method) => {
    assert.equal(method, 'bridge.poll_events');
    const events = queued; queued = [];
    return { events };
  };
  return { bridge, sent };
}
const fullPush = (devId, moduleSerial = devId) => [{ name: 'on_message', payload: { dev_id: devId, msg: JSON.stringify({ print: {
  ...mockReport('H2C'), command: 'push_status', msg: 0, gcode_state: 'IDLE', print_error: 0, hms: [] } }) } },
  { name: 'on_message', payload: { dev_id: devId, msg: JSON.stringify({ info: { command: 'get_version', module: [{ name: 'ota', sn: moduleSerial }] } }) } }];

test('a cloud safety read asks for a full push over the cloud and returns a status the safety gate accepts', async () => {
  const { bridge, sent } = stubBridge(devId => fullPush(devId));
  const status = await bridge.readFreshCloudStatus(SERIAL, {}, 3000);
  assert.deepEqual(sent.map(m => m.pushing?.command ?? m.info?.command), ['pushall', 'get_version']);
  assert.equal(status.observation.source, 'cloud');
  assert.equal(status.model, 'h2c');
  assert.equal(status.status, 'IDLE');
  assert.ok(status.raw.ams, 'the full report carries the AMS for auto_match_ams');
  // The same freshness and identity rules as a LAN read: a cloud status passes the gate, a forged source doesn't.
  assert.throws(() => safety.validatePrinterState({ ...status, observation: { ...status.observation, source: 'cache' } }, { model: 'h2c', nozzleDiameters: [0.4], materials: [], useAMS: false }),
    /fresh observed MQTT report/);
});

test('a cloud safety read refuses a report whose printer names another serial', async () => {
  const { bridge } = stubBridge(devId => fullPush(devId, '31BOTHERPRINTER'));
  await assert.rejects(bridge.readFreshCloudStatus(SERIAL, {}, 3000), /serial does not match/);
});

test('a cloud safety read never authorizes from a report older than its request', async () => {
  const { bridge } = stubBridge(() => []);
  // A full report that arrived before this request: cached state.
  bridge.printerReport(SERIAL).ingest({ print: { ...mockReport('H2C'), command: 'push_status', msg: 0, gcode_state: 'IDLE', print_error: 0, hms: [] } }, Date.now() - 60_000);
  await assert.rejects(bridge.readFreshCloudStatus(SERIAL, {}, 600), /Timed out waiting for a fresh cloud safety report/);
});
