import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

const { PrinterReport, mergeReport, pushAllMessage, PUSHINFO_TIMEOUT_MS } = await import('../dist/printer-report.js');
const safety = await import('../dist/safety/printer-state.js');

// A raw MQTT transport boundary; never contacts hardware.
const rawPrinter = (publish) => {
  const printer = new EventEmitter();
  printer.published = [];
  printer.publish = async payload => { printer.published.push(payload); return publish(payload, emit, printer); };
  const emit = (message, topic = 'device/01PTEST/report') => printer.emit('rawMessage', topic, Buffer.from(JSON.stringify(message)));
  printer.push = emit;
  return printer;
};
const full = (extra = {}) => ({ print: { command: 'push_status', msg: 0, model_id: 'C12', gcode_state: 'IDLE', print_error: 0, hms: [], nozzle_diameter: '0.4', nozzle_type: 'hardened_steel', ...extra } });
const delta = (extra = {}) => ({ print: { command: 'push_status', msg: 1, ...extra } });

test('deltas restore onto the last full report like Studio json_diff: objects merge, arrays and values replace', () => {
  const base = { ams: { tray_exist_bits: '3', tray_now: '255', ams: [{ id: '0', tray: [{ id: '0' }, { id: '1' }] }] }, device: { nozzle: { info: [{ id: 0 }] }, type: 1 }, mc_percent: 5 };
  const merged = mergeReport(base, { ams: { tray_now: '0', ams: [{ id: '0', tray: [{ id: '0' }] }] }, mc_percent: 6 });
  assert.equal(merged.ams.tray_exist_bits, '3');
  assert.equal(merged.ams.tray_now, '0');
  assert.deepEqual(merged.ams.ams, [{ id: '0', tray: [{ id: '0' }] }]);
  assert.deepEqual(merged.device, base.device);
  assert.equal(merged.mc_percent, 6);
  assert.equal(base.ams.tray_now, '255', 'the base is not modified');
});

test('a report keeps the full base, merges deltas, and asks for a full push after more than five unrestorable deltas', () => {
  const report = new PrinterReport();
  for (let i = 0; i < 5; i++) assert.equal(report.ingest(delta({ mc_percent: i })), 'unrestored');
  assert.equal(report.needsFullPush(), false);
  assert.equal(report.ingest(delta()), 'unrestored');
  assert.equal(report.needsFullPush(), true);
  assert.equal(report.state(), undefined);
  assert.equal(report.isReady(), false);
  assert.equal(report.ingest(full({ ams: { tray_exist_bits: '1' } }), 1000), 'full');
  assert.equal(report.needsFullPush(), false);
  assert.equal(report.ingest(delta({ ams: { tray_now: '0' } }), 2000), 'delta');
  assert.deepEqual(report.state().ams, { tray_exist_bits: '1', tray_now: '0' });
  assert.equal(report.fullAt, 1000);
  assert.equal(report.receivedAt, 2000);
  assert.equal(report.isReady(2000 + PUSHINFO_TIMEOUT_MS), true);
  assert.equal(report.isReady(2001 + PUSHINFO_TIMEOUT_MS), false);
  // A push without msg is a full report (Studio's LAN reading, ha-bambulab's default): it resets the base.
  assert.equal(report.ingest({ print: { command: 'push_status', gcode_state: 'RUNNING' } }, 3000), 'full');
  assert.deepEqual(report.state(), { command: 'push_status', gcode_state: 'RUNNING' });
  // Command replies and other sections are not state.
  assert.equal(report.ingest({ print: { command: 'project_file', result: 'fail' } }), undefined);
  assert.equal(report.ingest('not json'), undefined);
});

test('Studio pushall message carries version and push_target', () => {
  assert.deepEqual(pushAllMessage('40001'), { pushing: { sequence_id: '40001', command: 'pushall', version: 1, push_target: 1 } });
});

test('a fresh safety read restores a partial delta onto the full report, so tray presence is still checked', async () => {
  const printer = rawPrinter((payload, emit) => {
    if (!payload.pushing) return;
    assert.equal(payload.pushing.version, 1);
    assert.equal(payload.pushing.push_target, 1);
    queueMicrotask(() => {
      emit(full({ ams: { tray_exist_bits: '1', tray_now: '255', ams: [{ id: '0', tray: [{ id: '0', tray_type: 'PLA' }, { id: '1' }] }] } }));
      // Before, a shallow merge let this delta replace `ams` and drop tray_exist_bits, so slot 1 passed as present.
      emit(delta({ ams: { tray_now: '0', ams: [{ id: '0', tray: [{ id: '0', tray_type: 'PLA' }, { id: '1' }] }] } }));
    });
  });
  const status = await safety.readFreshPrinterStatus(printer, '01PTEST', 200);
  assert.equal(status.raw.ams.tray_exist_bits, '1');
  assert.equal(status.raw.ams.tray_now, '0');
  assert.ok(status.observation.fullAt >= status.observation.requestedAt);
  assert.ok(status.observation.receivedAt >= status.observation.fullAt);
  const requirements = { model: 'P1S', nozzleDiameters: [0.4], materials: ['PLA'], useAMS: true };
  assert.doesNotThrow(() => safety.validatePrinterState(status, { ...requirements, amsMapping: [0] }));
  assert.throws(() => safety.validatePrinterState(status, { ...requirements, amsMapping: [1] }), /reported empty/);
});

test('deltas without a full report never authorize a check', async () => {
  const printer = rawPrinter((payload, emit) => {
    if (payload.pushing) queueMicrotask(() => emit(delta({ model_id: 'C12', gcode_state: 'IDLE', print_error: 0, hms: [], nozzle_diameter: '0.4' })));
  });
  await assert.rejects(safety.readFreshPrinterStatus(printer, '01PTEST', 40), /timed out/i);
});

test('a read within the full-push interval waits for the next push instead of asking again, then asks once it passes', async () => {
  const previous = process.env.BAMBU_PUSHALL_MIN_MS;
  process.env.BAMBU_PUSHALL_MIN_MS = '300';
  try {
    let answer = true;
    const printer = rawPrinter((payload, emit) => { if (payload.pushing && answer) queueMicrotask(() => emit(full())); });
    await safety.readFreshPrinterStatus(printer, '01PTEST', 200);
    const pushes = () => printer.published.filter(message => message.pushing).length;
    assert.equal(pushes(), 1);
    const tick = () => new Promise(resolve => setTimeout(resolve, 10));
    await tick(); // a push from an earlier millisecond than the read
    // The printer's own next push (a delta) is enough: no second request inside the interval.
    const second = safety.readFreshPrinterStatus(printer, '01PTEST', 200);
    setTimeout(() => printer.push(delta({ mc_percent: 1 })), 20);
    const status = await second;
    assert.equal(pushes(), 1);
    assert.equal(status.raw.mc_percent, 1);
    assert.doesNotThrow(() => safety.validatePrinterState(status, { model: 'P1S', nozzleDiameters: [0.4], materials: ['PLA'], useAMS: false }));
    // Nothing pushed: the request goes out once the interval has passed.
    await new Promise(resolve => setTimeout(resolve, 350));
    const startedAt = Date.now();
    answer = true;
    const third = safety.readFreshPrinterStatus(printer, '01PTEST', 200);
    await third;
    assert.equal(pushes(), 2);
    assert.ok(Date.now() - startedAt < 300, 'past the interval the request is sent at once');
    answer = false;
    await tick();
    const fourth = safety.readFreshPrinterStatus(printer, '01PTEST', 100);
    setTimeout(() => { answer = true; }, 50);
    // The deferred request is answered and the read completes after the interval.
    await fourth;
    assert.equal(pushes(), 3);
  } finally {
    if (previous === undefined) delete process.env.BAMBU_PUSHALL_MIN_MS; else process.env.BAMBU_PUSHALL_MIN_MS = previous;
  }
});

test('checks require a restored full report from around the request and a recent push (Studio is_info_ready)', () => {
  const now = Date.now();
  const status = (observation) => ({ connected: true, model: 'P1S', serial: '01PTEST', raw: full().print, observation: { source: 'mqtt', identitySource: 'report', ...observation } });
  const requirements = { model: 'P1S', nozzleDiameters: [0.4], materials: ['PLA'], useAMS: false };
  assert.doesNotThrow(() => safety.validatePrinterState(status({ requestedAt: now - 10, fullAt: now - 1000, receivedAt: now - 5 }), requirements));
  for (const observation of [
    { requestedAt: now - 10, receivedAt: now - 5 },                       // no full report behind it
    { requestedAt: now - 10, fullAt: now - 10_000, receivedAt: now - 5 }, // the base is older than one full-push interval
    { requestedAt: now - 10, fullAt: now - 1, receivedAt: now - 5 },      // a "full" report newer than the push it is part of
    { requestedAt: now - 10, fullAt: now - 20, receivedAt: now - 20 },    // nothing pushed after the request
    { requestedAt: now - 16_000, fullAt: now - 16_000, receivedAt: now - 15_500 }, // older than PUSHINFO_TIMEOUT
  ]) {
    assert.throws(() => safety.validatePrinterState(status(observation), requirements), /fresh observed MQTT report/, JSON.stringify(observation));
  }
});

test("status snapshots keep one entry per get_version module", async () => {
  const { uniqueModules } = await import("../dist/printers/bambu.js");
  const ota = { name: "ota", sn: "31B", sw_ver: "01.01" };
  const ams = { name: "n3f/0", sn: "19C", sw_ver: "04.00" };
  const newer = { name: "ota", sn: "31B", sw_ver: "01.02" };
  assert.deepEqual(uniqueModules([ota, ams, ota, ams, newer]), [ams, newer]);
});
