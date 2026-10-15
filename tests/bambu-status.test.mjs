import assert from "node:assert/strict";
import { test } from "node:test";
import { BambuClient } from "bambu-node";
import { BambuImplementation } from "../dist/printers/bambu.js";

function client(serial = "239TEST") {
  return new BambuClient({ host: "127.0.0.1", serialNumber: serial, accessToken: "test" });
}

async function report(printer, payload) {
  // Exercise the actual patched MQTT parser without connecting to hardware.
  await printer.onMessage(JSON.stringify(payload), `device/${printer.config.serialNumber}/report`);
}

for (const [prefix, model] of [["093", "H2S"], ["094", "H2D"], ["31B", "H2C"], ["239", "H2DPRO"], ["22E", "P2S"], ["01P", "P1S"], ["039", "A1"], ["030", "A1M"]]) {
  test(`OTA model detection accepts ${model} (${prefix})`, async () => {
    const printer = client(`${prefix}TEST`);
    await report(printer, { info: { command: "get_version", module: [{ name: "ota", sn: `${prefix}TEST` }] } });
    assert.equal(printer.data.model, model);
    await report(printer, { print: { command: "push_status", gcode_state: "IDLE", nozzle_temper: 27 } });
    assert.equal(printer.status, "IDLE");
    assert.equal(printer.data.nozzle_temper, 27);
  });
}

test("unknown OTA serial preserves the detected identity and continues status updates", async () => {
  for (const knownModel of [undefined, "H2C"]) {
    const printer = client("NEWTEST");
    printer.data.model = knownModel;
    await report(printer, { info: { command: "get_version", module: [{ name: "ota", sn: "NEWTEST" }] } });
    assert.equal(printer.data.model, knownModel);
    await report(printer, { print: { command: "push_status", gcode_state: "IDLE", bed_temper: 25 } });
    assert.equal(printer.data.bed_temper, 25);
  }
});

test("version messages without OTA data preserve identity and do not terminate the listener", async () => {
  const printer = client();
  printer.data.model = "H2C";
  await report(printer, { info: { command: "get_version", module: [{ name: "ams", sn: "AMSTEST" }] } });
  assert.equal(printer.data.model, "H2C");
  assert.equal(printer.data.modules[0].name, "ams");
});

test("unexpected status transitions update status and accept the next report", async () => {
  const printer = client();
  for (const state of ["PAUSE", "FINISH", "IDLE", "FAILED", "PAUSE"]) {
    await report(printer, { print: { command: "push_status", gcode_state: state, nozzle_temper: 30 } });
    assert.equal(printer.status, state);
    assert.equal(printer.data.gcode_state, state);
  }
});

for (const [name, data, expected] of [
  ["P2S CTC temperature", { device: { ctc: { info: { temp: 26 } } } }, 26],
  ["packed CTC current and target temperatures", { device: { ctc: { info: { temp: 3932186 } } } }, 26],
  ["zero CTC temperature before legacy fields", { device: { ctc: { info: { temp: 0 } } }, chamber_temper: 30 }, 0],
  ["legacy chamber temperature", { chamber_temper: 32 }, 32],
  ["legacy frame temperature", { frame_temper: 29 }, 29],
  ["missing temperature", { device: { ctc: null } }, 0],
  ["invalid CTC temperature falls back", { device: { ctc: { info: { temp: -1 } } }, chamber_temper: 31 }, 31],
]) {
  test(`printer status reads ${name}`, async () => {
    const reportData = { gcode_state: "IDLE", model: "P2S", ...data };
    const bambu = new BambuImplementation();
    bambu.printerStore = { waitForInitialReport: async () => reportData };
    bambu.getPrinter = async () => ({ data: reportData, publish: async () => {} });

    const status = await bambu.getStatus("127.0.0.1", "TEST_SERIAL", "TEST_TOKEN");
    assert.equal(status.connected, true);
    assert.equal(status.temperatures.chamber, expected);
  });
}

test("dual-nozzle status reports each nozzle from the packed extruder temperatures", async () => {
  // Recorded H2D report (ha-bambulab mock, MIT): right 245/245 (0x00F500F5), left 47 idle; bed packed 70/70.
  const { mockReport } = await import("./safety/push-fixtures.mjs");
  const reportData = mockReport("H2D");
  const bambu = new BambuImplementation();
  bambu.printerStore = { waitForInitialReport: async () => reportData };
  bambu.getPrinter = async () => ({ data: reportData, publish: async () => {} });
  const status = await bambu.getStatus("127.0.0.1", "094TEST", "TEST_TOKEN");
  assert.deepEqual(status.temperatures.nozzles, [{ id: 0, side: "right", actual: 245, target: 245 }, { id: 1, side: "left", actual: 47, target: 0 }]);
  // Without the legacy fields the packed values are used.
  const packedOnly = { ...reportData, bed_temper: undefined, bed_target_temper: undefined, nozzle_temper: undefined, nozzle_target_temper: undefined };
  bambu.printerStore = { waitForInitialReport: async () => packedOnly };
  const packed = await bambu.getStatus("127.0.0.1", "094TEST", "TEST_TOKEN");
  assert.deepEqual(packed.temperatures.bed, { actual: 70, target: 70 });
  assert.deepEqual(packed.temperatures.nozzle, { actual: 245, target: 245 });
});
