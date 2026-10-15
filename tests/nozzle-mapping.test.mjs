// Hotend-rack nozzle mapping (get_auto_nozzle_mapping) against faked printer replies; no printer is contacted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  buildAutoNozzleMappingRequest, checkAutoNozzleMappingReply, matchAutoNozzleMappingReply, nozzleMappingVersion,
  nozzleRackSupported, requestNozzleMapping,
} from "../dist/nozzle-mapping.js";
import { parseSliceNozzlePlan } from "../dist/safety/slice-info.js";
import { BambuNetworkBridge } from "../dist/bambu-network-bridge.js";
import { queryLanPrinter } from "../dist/printers/bambu.js";
import { mockReport } from "./safety/push-fixtures.mjs";

function h2cReport() {
  const raw = structuredClone(mockReport("H2C"));
  Object.assign(raw.ams.ams[0].tray[0], { tray_info_idx: "GFL99", tray_color: "161616FF", tray_type: "PLA" });
  Object.assign(raw.vir_slot.find(slot => slot.id === "254"), { tray_info_idx: "GFL99", tray_color: "76D9F4FF", tray_type: "PLA" });
  return raw;
}

// The GUI-sliced H2C keychain's plan: filament 1 on the right (nozzle 1), filament 2 on the left (nozzle 0).
const SLICE_INFO = `<?xml version="1.0" encoding="UTF-8"?>
<config><plate>
  <metadata key="index" value="1"/>
  <metadata key="enable_filament_dynamic_map" value="false"/>
  <metadata key="filament_maps" value="2 1"/>
  <filament id="1" tray_info_idx="GFL99" type="PLA" color="#161616" group_id="1" nozzle_diameter="0.40" volume_type="Standard"/>
  <filament id="2" tray_info_idx="GFL99" type="PLA" color="#76D9F4" group_id="0" nozzle_diameter="0.40" volume_type="Standard"/>
  <nozzle id="0" extruder_id="1" nozzle_diameter="0.4" volume_type="Standard"/>
  <nozzle id="1" extruder_id="2" nozzle_diameter="0.4" volume_type="Standard"/>
</plate></config>`;
const SEQUENCE = JSON.stringify({ plate_1: { nozzle_sequence: [1, 0], optimal_assignment: [0, 1], sequence: [1, 2, 1] } });

function job(overrides = {}) {
  return {
    model: "h2c", nozzleDiameters: [0.4, 0.4], usedFilamentPositions: [0, 1], filamentMap: [2, 1], physicalExtruderMap: [1, 0],
    nozzlePlan: parseSliceNozzlePlan(SLICE_INFO, SEQUENCE, 0, 2), ...overrides,
  };
}

test("slice_info.config gives the plate's nozzles, each filament's nozzle and the change sequence", () => {
  assert.deepEqual(parseSliceNozzlePlan(SLICE_INFO, SEQUENCE, 0, 2), {
    nozzles: [{ id: 0, extruder: 1, diameter: 0.4, flow: "standard" }, { id: 1, extruder: 2, diameter: 0.4, flow: "standard" }],
    filamentNozzles: [1, 0], filamentChangeSequence: [0, 1, 0], dynamicNozzleMap: false,
  });
  assert.equal(parseSliceNozzlePlan(SLICE_INFO, SEQUENCE, 1, 2), undefined);
  assert.throws(() => parseSliceNozzlePlan(SLICE_INFO.replace('group_id="1" nozzle_diameter="0.40"', 'group_id="1" nozzle_diameter="0.60"'), undefined, 0, 2), /contradicts its nozzle/);
  assert.throws(() => parseSliceNozzlePlan(SLICE_INFO.replace('<filament id="2"', '<filament id="3"'), undefined, 0, 2), /does not declare/);
});

test("rack support is the report's fun bit 60, and a mapping is asked for jobs on the rack extruder", () => {
  const raw = h2cReport();
  assert.equal(nozzleRackSupported(raw, "h2c"), true);
  assert.equal(nozzleRackSupported({ ...raw, fun: "04023FF1AFFF9CB7" }, "h2c"), false);
  assert.equal(nozzleRackSupported({}, "h2c"), false);
  assert.equal(nozzleRackSupported(raw, "h2d"), false);
  assert.equal(nozzleMappingVersion(raw, job()), 0);
  // Only the left nozzle used: the rack is not involved.
  const left = parseSliceNozzlePlan(SLICE_INFO.replace(/<nozzle id="1"[^>]*>/, "").replace('group_id="1"', 'group_id="0"'), undefined, 0, 2);
  assert.equal(nozzleMappingVersion(raw, job({ filamentMap: [1, 1], nozzlePlan: left })), undefined);
  const dynamic = { ...job().nozzlePlan, dynamicNozzleMap: true };
  assert.equal(nozzleMappingVersion(raw, job({ nozzlePlan: dynamic })), 1);
});

test("the V0 request is Studio's CtrlGetAutoNozzleMappingV0 body", () => {
  const request = buildAutoNozzleMappingRequest(h2cReport(), job(), [0, 254], { version: 0, sequenceId: "41000", calibration: 2, paValue: 0 });
  const trays = Array(33).fill(0xffff);
  trays[1] = 0;            // filament 1: AMS 0 slot 0
  trays[2] = 254 << 8;     // filament 2: the left external holder
  assert.deepEqual(request, { print: {
    command: "get_auto_nozzle_mapping", sequence_id: "41000", calibration: 2, extrude_cali_manual_mode: 0,
    // Filament 1 comes first in the change sequence (1, 2, 1), filament 2 second; index 0 is unused.
    filament_seq: [-1, 0, 1],
    ams_mapping: trays,
    fila_info: [
      { id: 1, direction: 2, group: 1, nozzle_d: "0.40", nozzle_v: "Standard", cate: "GFL99", color: "161616FF" },
      { id: 2, direction: 1, group: 0, nozzle_d: "0.40", nozzle_v: "Standard", cate: "GFL99", color: "76D9F4FF" },
    ],
    nozzle_info: [
      // The mounted main hotend is named by the rack place it came from (tar_id 20).
      { pos: 20, nozzle_d: "0.40", nozzle_v: "Standard", wear: 0, cate: "GFG00", color: "688197FF" },
      { pos: 1, nozzle_d: "0.40", nozzle_v: "Standard", wear: 0, cate: "", color: "00000000" },
      { pos: 16, nozzle_d: "0.20", nozzle_v: "Standard", wear: 0, cate: "", color: "00000000" },
      { pos: 18, nozzle_d: "0.60", nozzle_v: "Standard", wear: 0, cate: "", color: "00000000" },
      { pos: 21, nozzle_d: "0.40", nozzle_v: "Standard", wear: 0, cate: "", color: "00000000" },
      { pos: 19, nozzle_d: "0.40", nozzle_v: "Standard", wear: 0, cate: "", color: "00000000" },
      { pos: 17, nozzle_d: "0.40", nozzle_v: "Standard", wear: 0, cate: "GFG02", color: "00AE42FF" },
    ],
  } });
  const v1 = buildAutoNozzleMappingRequest(h2cReport(), job(), [0, 254], { version: 1, sequenceId: "41001", calibration: 2, paValue: 0 });
  assert.deepEqual(v1.print.group_info, [{ id: 0, ext: 1, dia: 0.4, vol: "Standard" }, { id: 1, ext: 2, dia: 0.4, vol: "Standard" }]);
  assert.equal(v1.print.version, 1);
  // An abnormal hotend (stat bits 1-2) is left out, as DevNozzle::IsNormal does.
  const raw = h2cReport();
  raw.device.nozzle.info.find(nozzle => nozzle.id === 19).stat = 2;
  assert.ok(!buildAutoNozzleMappingRequest(raw, job(), [0, 254], { version: 0, sequenceId: "1", calibration: 2, paValue: 0 }).print.nozzle_info.some(entry => entry.pos === 19));
});

test("only the reply with the request's sequence id and an outcome counts", () => {
  const reply = { print: { command: "get_auto_nozzle_mapping", sequence_id: "41000", result: "success", mapping: [21, 1], type: "auto", version: 0 } };
  assert.deepEqual(matchAutoNozzleMappingReply(JSON.stringify(reply), "41000"), { result: "success", type: "auto", version: 0, mapping: [21, 1] });
  assert.equal(matchAutoNozzleMappingReply(JSON.stringify(reply), "41001"), undefined);
  assert.equal(matchAutoNozzleMappingReply({ print: { command: "get_auto_nozzle_mapping", sequence_id: "41000" } }, "41000"), undefined);
  assert.equal(matchAutoNozzleMappingReply({ print: { command: "push_status", sequence_id: "41000", result: "success" } }, "41000"), undefined);
});

test("the printer's table is checked against the job like Studio's print dialog", () => {
  const raw = h2cReport();
  // Filament 1 on rack place 6 (id 21, 0.4 Standard), filament 2 on the left.
  assert.deepEqual(checkAutoNozzleMappingReply({ result: "success", mapping: [21, 1] }, raw, job(), 0), {
    mapping: [21, 1], version: 0, warnings: [], assignments: [{ filament: 1, hotend: "R6" }, { filament: 2, hotend: "L" }],
  });
  // tar_id names the mounted main hotend.
  assert.equal(checkAutoNozzleMappingReply({ result: "success", mapping: [20, 1] }, raw, job(), 0).assignments[0].hotend, "R");
  assert.throws(() => checkAutoNozzleMappingReply({ result: "fail", errno: 8 }, raw, job(), 0), /could not map.*code 8: the hotend rack is full/);
  assert.throws(() => checkAutoNozzleMappingReply({ result: "failed", reason: "timeout" }, raw, job(), 0), /did not return a hotend mapping for this job \(timeout\)/);
  assert.throws(() => checkAutoNozzleMappingReply({ result: "success", mapping: [] }, raw, job(), 0), /empty or malformed/);
  // Rack place 3 (id 18) holds a 0.6 mm hotend; the filament is sliced for 0.4 mm.
  assert.throws(() => checkAutoNozzleMappingReply({ result: "success", mapping: [18, 1] }, raw, job(), 0), /filament 1 on R3 \(0\.6 mm Standard\), but it is sliced for 0\.4 mm Standard/);
  assert.throws(() => checkAutoNozzleMappingReply({ result: "success", mapping: [30, 1] }, raw, job(), 0), /R15, which it does not report/);
  assert.throws(() => checkAutoNozzleMappingReply({ result: "success", mapping: [-1, 1] }, raw, job(), 0), /leaves filament 1 without a hotend/);
  assert.match(checkAutoNozzleMappingReply({ result: "success", errno: 9, mapping: [21, 1] }, raw, job(), 0).warnings[0], /fewer suitable hotends/);
});

test("requestNozzleMapping sends the query, checks the answer and reports a silent printer", async () => {
  const raw = h2cReport();
  let sent;
  const answer = (mapping) => async (message, match) => {
    sent = message;
    return match(JSON.stringify({ print: { command: "get_auto_nozzle_mapping", sequence_id: message.print.sequence_id, result: "success", mapping } }));
  };
  const asked = await requestNozzleMapping(raw, job(), [0, 254], { sequenceId: "41010", calibration: 2, paValue: 0, query: answer([21, 1]) });
  assert.equal(sent.print.command, "get_auto_nozzle_mapping");
  assert.deepEqual(asked.checked.mapping, [21, 1]);
  assert.equal(asked.warning, undefined);
  const silent = await requestNozzleMapping(raw, job(), [0, 254], { sequenceId: "41011", calibration: 2, paValue: 0, waitMs: 50, query: async () => undefined });
  assert.equal(silent.checked, undefined);
  assert.match(silent.warning, /did not answer get_auto_nozzle_mapping within 0\.05 s; the job was sent without a hotend mapping/);
  const broken = await requestNozzleMapping(raw, job(), [0, 254], { sequenceId: "41012", calibration: 2, paValue: 0, query: async () => { throw new Error("bridge down"); } });
  assert.match(broken.warning, /could not ask the printer for a hotend mapping \(bridge down\)/);
  await assert.rejects(requestNozzleMapping(raw, job(), [0, 254], { sequenceId: "41013", calibration: 2, paValue: 0, query: answer([18, 1]) }), /sliced for 0\.4 mm/);
  // Without the rack (or without right-side filaments) nothing is asked.
  assert.equal(await requestNozzleMapping({ ...raw, fun: "0" }, job(), [0, 254], { sequenceId: "41014", calibration: 2, paValue: 0, query: async () => assert.fail("asked") }), undefined);
  // A file without a nozzle plan can't be asked about; it is reported, not refused.
  const unplanned = await requestNozzleMapping(raw, job({ nozzlePlan: undefined }), [0, 254], { sequenceId: "41015", calibration: 2, paValue: 0, query: async () => assert.fail("asked") });
  assert.match(unplanned.warning, /no hotend mapping was requested: The sliced file has no nozzle plan/);
});

test("the signed bridge returns the printer's mapping reply among the plugin's message events", async () => {
  const bridge = new BambuNetworkBridge();
  let sent;
  bridge.ensurePrinterChannel = async () => {};
  bridge.callWithAgent = async (method, payload = {}) => {
    if (method === "net.send_message") sent = JSON.parse(payload.msg);
    return { ok: true, value: 0 };
  };
  bridge.request = async () => !sent ? { ok: true, events: [] } : { ok: true, events: [
    { name: "on_message", payload: { dev_id: "31BTEST", msg: JSON.stringify({ print: { command: "get_auto_nozzle_mapping", sequence_id: "1", result: "success", mapping: [0] } }) } },
    { name: "on_message", payload: { dev_id: "31BTEST", msg: JSON.stringify({ print: { command: "get_auto_nozzle_mapping", sequence_id: sent.print.sequence_id, result: "success", mapping: [21, 1] } }) } },
  ] };
  const message = JSON.stringify({ print: { command: "get_auto_nozzle_mapping", sequence_id: "41020" } });
  const reply = await bridge.queryPrinter("31BTEST", message, value => matchAutoNozzleMappingReply(value, "41020"), 2000);
  assert.deepEqual(reply, { result: "success", mapping: [21, 1] });
  sent = undefined;
  bridge.request = async () => ({ ok: true, events: [] });
  assert.equal(await bridge.queryPrinter("31BTEST", message, value => matchAutoNozzleMappingReply(value, "41020"), 100), undefined);
});

test("the LAN query listens on the report topic until the reply or the wait ends", async () => {
  const printer = new EventEmitter();
  printer.publish = async (message) => {
    setImmediate(() => {
      printer.emit("rawMessage", "device/31BTEST/report", Buffer.from(JSON.stringify({ print: { command: "push_status" } })));
      printer.emit("rawMessage", "device/31BTEST/report", Buffer.from(JSON.stringify({ print: { command: "get_auto_nozzle_mapping", sequence_id: message.print.sequence_id, result: "success", mapping: [21, 1] } })));
    });
  };
  const reply = await queryLanPrinter(printer, { print: { command: "get_auto_nozzle_mapping", sequence_id: "41030" } }, value => matchAutoNozzleMappingReply(value, "41030"), 2000);
  assert.deepEqual(reply.mapping, [21, 1]);
  assert.equal(printer.listenerCount("rawMessage"), 0);
  printer.publish = async () => {};
  assert.equal(await queryLanPrinter(printer, { print: { command: "get_auto_nozzle_mapping", sequence_id: "41031" } }, value => matchAutoNozzleMappingReply(value, "41031"), 50), undefined);
  assert.equal(printer.listenerCount("rawMessage"), 0);
});
