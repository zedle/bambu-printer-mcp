import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import JSZip from "jszip";
import { BambuImplementation, judgeDispatchReport, printerRequiresSignedCommands } from "../dist/printers/bambu.js";
import { BambuNetworkBridge } from "../dist/bambu-network-bridge.js";
import { withPrintSnapshot } from "../dist/safety/artifact.js";

// Mocked printers never report a started job; tests that cover it opt back in.
process.env.BAMBU_DISPATCH_CHECK_MS = "0";
// These tests cover the opt-in human prompts; the unattended default has its own tests.
process.env.BAMBU_REQUIRE_CONFIRMATION = "1";

const root = fileURLToPath(new URL("..", import.meta.url));
const host = "127.0.0.1";
const serial = "01PTESTSAFETY";
const token = "TEST_TOKEN";

function safetyStatus({ model = "p1s", nozzle = "0.4", state = "IDLE", ...raw } = {}) {
  return {
    connected: true, model, status: state, serial,
    raw: { model, gcode_state: state, nozzle_diameter: nozzle, print_error: 0, hms: [], ...raw },
    observation: { source: "mqtt", receivedAt: Date.now(), requestedAt: Date.now() - 1, fullAt: Date.now() - 1, identitySource: "report" },
  };
}

async function fixture(t, { model = "p1s", nozzle = "0.4", nozzleDiameters, material = "PLA", gcode = "M104 S220\nM140 S60\nG1 X10 Y10 Z1\n", raw = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-safety-dispatch-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, raw ? "job.gcode" : "job.gcode.3mf");
  const nozzles = (nozzleDiameters ?? [nozzle]).map(String);
  const content = `; printer_model = Bambu Lab ${model === "a1mini" ? "A1 mini" : model.toUpperCase()}\n; nozzle_diameter = ${nozzles.join(";")}\n; filament_type = ${material}\n; filament_colour = #FFFFFF\n; curr_bed_type = Textured PEI Plate\n${gcode}`;
  if (raw) await fs.writeFile(file, content);
  else {
    const zip = new JSZip();
    zip.file("3D/3dmodel.model", '<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model" name="cube.stl"><mesh><vertices/><triangles/></mesh></object></resources><build><item objectid="1"/></build></model>');
    zip.file("Metadata/plate_1.gcode", content);
    zip.file("Metadata/plate_1.json", JSON.stringify({ filament_ids: [0] }));
    zip.file("Metadata/project_settings.config", JSON.stringify({ printer_model: model, nozzle_diameter: nozzles, filament_type: [material], curr_bed_type: "Textured PEI Plate" }));
    await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
  }
  return file;
}

function isolatedPrinter(status = safetyStatus()) {
  const printer = new BambuImplementation(async () => true);
  const events = [];
  printer.ftpUpload = async (_host, _token, file, remote) => events.push({ action: "upload", file, remote, bytes: await fs.readFile(file) });
  printer.getSafetyStatus = async () => { events.push({ action: "status" }); return status; };
  printer.getPrinter = async () => {
    events.push({ action: "connect" });
    return { publish: async (payload) => events.push({ action: "publish", payload }) };
  };
  return { printer, events };
}

function assertNoDispatch(events) {
  assert.deepEqual(events.filter(({ action }) => action === "upload" || action === "publish"), [], "rejected print must not upload bytes or publish a print command");
}

for (const [name, gcode] of [
  ["declared PLA at 400 C", "M104 S400\n"],
  ["bed at 300 C", "M140 S300\n"],
  ["nonfinite nozzle target", "M104 SNaN\n"],
  ["R-form waiting nozzle target", "M109 R400\n"],
]) {
  test(`print3mf rejects ${name} before upload or publish`, async (t) => {
    const file = await fixture(t, { gcode });
    const { printer, events } = isolatedPrinter();
    await assert.rejects(printer.print3mf(host, serial, token, { projectName: "unsafe", filePath: file, bambuModel: "p1s", nozzleDiameters: [0.4], useAMS: false }), /temperature|thermal|finite|target|limit/i);
    assertNoDispatch(events);
  });
}

for (const [name, fileOptions, status, options, error] of [
  ["file model mismatch", { model: "h2d" }, safetyStatus(), {}, /model|P1S|H2D/i],
  ["requested nozzle mismatch", { nozzle: "0.8" }, safetyStatus(), {}, /nozzle|diameter/i],
  ["live model mismatch", {}, safetyStatus({ model: "a1mini" }), {}, /model|identity/i],
  ["live nozzle mismatch", {}, safetyStatus({ nozzle: "0.6" }), {}, /nozzle|diameter/i],
  ["busy printer", {}, safetyStatus({ state: "RUNNING" }), {}, /state|busy|RUNNING/i],
  ["active printer error", {}, safetyStatus({ print_error: 1234 }), {}, /error|fault/i],
  ["reported external-spool material contradicting PLA", {}, safetyStatus({ vt_tray: { tray_type: "ABS", nozzle_temp_min: "240", nozzle_temp_max: "270" } }), {}, /material|contradict/i],
  ["missing selected plate on the legacy route", {}, safetyStatus(), { plateIndex: 98 }, /plate|present|missing/i],
]) {
  test(`print3mf rejects ${name} before upload or publish`, async (t) => {
    const file = await fixture(t, fileOptions);
    const { printer, events } = isolatedPrinter(status);
    await assert.rejects(printer.print3mf(host, serial, token, { projectName: "unsafe", filePath: file, bambuModel: "p1s", nozzleDiameters: [0.4], useAMS: false, ...options }), error);
    assertNoDispatch(events);
  });
}

test("low-level print3mf requires a model even when the serial has a known prefix", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter();
  await assert.rejects(printer.print3mf(host, serial, token, { projectName: "missing-model", filePath: file, useAMS: false }), /model.*required|provide.*model|explicit.*model/i);
  assert.deepEqual(events, [], "model validation must happen before connecting");
});

test("legacy gcode_file refuses an AMS mapping it cannot carry", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter();
  await assert.rejects(printer.print3mf(host, serial, token, { projectName: "mapped", filePath: file, bambuModel: "p1s", useAMS: true, amsSlots: [1] }), /AMS|mapping|gcode_file|legacy/i);
  assertNoDispatch(events);
});

test("a project AMS mapping cannot bypass a reported material mismatch", async (t) => {
  const legacyFile = await fixture(t);
  const file = legacyFile.replace(".gcode.3mf", ".3mf");
  await fs.rename(legacyFile, file);
  const { printer, events } = isolatedPrinter(safetyStatus({ ams: { ams: [{ id: "0", tray: [{ id: "1", tray_type: "ABS", nozzle_temp_min: "240", nozzle_temp_max: "270" }] }] } }));
  await assert.rejects(printer.print3mf(host, serial, token, { projectName: "conflicting-material", filePath: file, bambuModel: "p1s", useAMS: true, amsSlots: [1] }), /material|contradict/i);
  assertNoDispatch(events);
});

test("printer becoming busy during upload stops the final print command", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter();
  let reads = 0;
  printer.getSafetyStatus = async () => safetyStatus({ state: ++reads <= 2 ? "IDLE" : "RUNNING" });
  await assert.rejects(printer.print3mf(host, serial, token, { projectName: "state-changed", filePath: file, bambuModel: "p1s", useAMS: false }), /state|busy|RUNNING/i);
  assert.equal(events.filter(({ action }) => action === "upload").length, 1);
  assert.equal(events.filter(({ action }) => action === "publish").length, 0);
});

for (const action of ["stop", "heater-off"]) {
  test(`${action} during upload is immediate and prevents pending print dispatch`, async (t) => {
    const file = await fixture(t);
    const { printer, events } = isolatedPrinter();
    let releaseUpload;
    const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
    let markUploadStarted;
    const uploadStarted = new Promise((resolve) => { markUploadStarted = resolve; });
    printer.ftpUpload = async () => { events.push({ action: "upload" }); markUploadStarted(); await uploadGate; };
    const pendingPrint = printer.print3mf(host, serial, token, { projectName: "cancelled", filePath: file, bambuModel: "p1s", useAMS: false });
    // Attach the rejection observer before cancellation to avoid an unhandled rejection.
    const outcome = pendingPrint.then(value => ({ value }), error => ({ error }));
    await uploadStarted;
    const safetyAction = action === "stop" ? printer.cancelJob(host, serial, token) : printer.setTemperature(host, serial, token, "nozzle", 0);
    let timeout;
    try {
      await Promise.race([safetyAction, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`${action} waited behind a pending upload`)), 1500); })]);
      const publishes = events.filter((event) => event.action === "publish");
      assert.equal(publishes.length, 1, "stop/off must publish while the upload is blocked");
      if (action === "stop") assert.equal(publishes[0].payload.print.command, "stop");
      else assert.match(JSON.stringify(publishes[0].payload), /M104 S0/);
    } finally {
      clearTimeout(timeout);
      releaseUpload();
      await safetyAction;
    }
    const completed = await outcome;
    assert.match(completed.error?.message ?? "", /cancelled|canceled|stop|heater-off/i, "the pending print must be cancelled");
    assert.equal(events.filter((event) => event.action === "publish").length, 1, "no print command may follow stop/off");
  });
}

test("upload-and-print rejects dangerous raw G-code before uploading", async (t) => {
  const file = await fixture(t, { raw: true, gcode: "M104 S400\n" });
  const { printer, events } = isolatedPrinter();
  await assert.rejects(printer.uploadFile(host, serial, token, file, "unsafe.gcode", true, "p1s"), /temperature|thermal|limit/i);
  assertNoDispatch(events);
});

test("an inspected print uploads its private copy when the caller's file changes", async (t) => {
  const file = await fixture(t);
  const expected = await fs.readFile(file);
  const { printer, events } = isolatedPrinter();
  let reads = 0;
  printer.getSafetyStatus = async () => {
    if (++reads === 1) await fs.writeFile(file, "M104 S400\n");
    return safetyStatus();
  };
  const result = await printer.print3mf(host, serial, token, { projectName: "snapshot", filePath: file, bambuModel: "p1s", useAMS: false });
  assert.equal(result.status, "dispatched_unconfirmed");
  const upload = events.find(({ action }) => action === "upload");
  assert.notEqual(upload.file, file);
  assert.deepEqual(upload.bytes, expected, "uploaded bytes must be the file that passed inspection");
  assert.match(upload.remote, /^\/cache\/checked-[a-f0-9-]+-job\.gcode\.3mf$/);
  assert.match(JSON.stringify(events.find(({ action }) => action === "publish").payload), new RegExp(path.posix.basename(upload.remote).replaceAll(".", "\\.")));
});

test("the signed-command flag is read like Bambu's plugin: fun bit 29, else flag3 bit 4", () => {
  for (const [raw, expected] of [
    [{ fun: "14023FF1AFFF9CB7" }, true], // H2C
    [{ fun: "11A30F9CFB" }, true], // X1C
    [{ fun: "1F", flag3: 31 }, false], // fun wins over flag3
    [{ flag3: 31 }, true], // A1
    [{ flag3: 671 }, true], // P1P
    [{ flag3: "15" }, false],
    [{}, false],
    [undefined, false],
  ]) assert.equal(printerRequiresSignedCommands(raw), expected, JSON.stringify(raw));
});

test("a report after a print command is judged by this job's identity", () => {
  const idle = { gcode_state: "IDLE", task_id: "100", subtask_id: "100", print_error: 0, hms: [] };
  const job = "cache/checked-1234-cube.gcode.3mf";
  for (const [name, report, kind] of [
    ["this job running", { gcode_state: "RUNNING", subtask_name: "checked-1234-cube" }, "started"],
    ["this job by file name", { gcode_state: "PREPARE", gcode_file: "/data/Metadata/checked-1234-cube.gcode.3mf" }, "started"],
    ["a new task id", { gcode_state: "PREPARE", task_id: "101" }, "started"],
    ["a delta naming no job", { gcode_state: "PREPARE" }, "started"],
    ["another job running", { gcode_state: "RUNNING", subtask_name: "other", task_id: "101" }, undefined],
    ["still idle", { gcode_state: "IDLE" }, undefined],
    ["the printer's project_file refusal", { command: "project_file", result: "fail", reason: "file broken" }, "failed"],
    ["this job FAILED", { gcode_state: "FAILED", subtask_name: "checked-1234-cube" }, "failed"],
    ["a new print error", { gcode_state: "IDLE", print_error: 0x0700_8012 }, "failed"],
    ["the unsigned-command refusal", { hms: [{ attr: 0x05000500, code: 0x00010007 }] }, "rejected"],
  ]) assert.equal(judgeDispatchReport(report, idle, job)?.kind, kind, name);
  assert.equal(judgeDispatchReport({ gcode_state: "RUNNING" }, { ...idle, gcode_state: "RUNNING" }, job), undefined, "no name while already printing proves nothing");
});

test("the LAN dispatch watch ignores another job's pushed report", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter();
  const { EventEmitter } = await import("node:events");
  const mqtt = new EventEmitter();
  mqtt.publish = async payload => {
    events.push({ action: "publish", payload });
    setTimeout(() => mqtt.emit("rawMessage", `device/${serial}/report`, Buffer.from(JSON.stringify({ print: { gcode_state: "RUNNING", subtask_name: "someone else" } }))), 50);
  };
  printer.getPrinter = async () => mqtt;
  process.env.BAMBU_DISPATCH_CHECK_MS = "500";
  t.after(() => { process.env.BAMBU_DISPATCH_CHECK_MS = "0"; });
  const result = await printer.print3mf(host, serial, token, { projectName: "mine", filePath: file, bambuModel: "p1s", useAMS: false });
  assert.equal(result.dispatch, "unconfirmed");
  assert.equal(result.status, "dispatched_unconfirmed");
});

test("the printer's answer to this project_file, matched by sequence id, decides a refused LAN print and is returned", async (t) => {
  const file = await fixture(t);
  const { EventEmitter } = await import("node:events");
  process.env.BAMBU_DISPATCH_CHECK_MS = "500";
  t.after(() => { process.env.BAMBU_DISPATCH_CHECK_MS = "0"; });
  const lan = (answer) => {
    const { printer, events } = isolatedPrinter();
    const mqtt = new EventEmitter();
    mqtt.publish = async payload => {
      events.push({ action: "publish", payload });
      const reply = (print) => setTimeout(() => mqtt.emit("rawMessage", `device/${serial}/report`, Buffer.from(JSON.stringify({ print }))), 20);
      // Another client's refusal must not count; the reply to this command's sequence id does.
      if (answer === "fail") { reply({ command: "project_file", sequence_id: "123", result: "success" }); reply({ command: "project_file", sequence_id: payload.print.sequence_id, result: "fail", reason: "file is damaged", err_code: 0x0500_4002 }); }
      if (answer === "success") {
        reply({ command: "project_file", sequence_id: payload.print.sequence_id, result: "success" });
        setTimeout(() => mqtt.emit("rawMessage", `device/${serial}/report`, Buffer.from(JSON.stringify({ print: { command: "push_status", gcode_state: "PREPARE", subtask_name: payload.print.subtask_name } }))), 60);
      }
    };
    printer.getPrinter = async () => mqtt;
    return printer;
  };
  await assert.rejects(lan("fail").print3mf(host, serial, token, { projectName: "broken", filePath: file, bambuModel: "p1s", useAMS: false }),
    /refused to start the job \(project_file replied fail: file is damaged, error 05004002; Bambu Studio: "Failed to start printing job"\)/);
  const result = await lan("success").print3mf(host, serial, token, { projectName: "fine", filePath: file, bambuModel: "p1s", useAMS: false });
  assert.equal(result.dispatch, "started");
  assert.deepEqual(result.printerReply, { result: "success" });
});

test("a bridge print's project_file answer relayed by the plugin is part of the dispatch result", async () => {
  const { printer } = isolatedPrinter(safetyStatus());
  process.env.BAMBU_DISPATCH_CHECK_MS = "100";
  try {
    const refused = { poll: async () => ({ section: "print", command: "project_file", result: "fail", reason: "busy" }) };
    await assert.rejects(printer.confirmDispatchedJob(host, serial, token, safetyStatus(), "job", () => {}, refused), /refused to start the job \(project_file replied fail: busy/);
    const accepted = { poll: async () => ({ section: "print", command: "project_file", result: "success" }) };
    assert.equal(await printer.confirmDispatchedJob(host, serial, token, safetyStatus(), "job", () => {}, accepted), "unconfirmed");
    assert.deepEqual(accepted.reply, { section: "print", command: "project_file", result: "success" });
    const silent = { poll: async () => { throw new Error("bridge gone"); } };
    assert.equal(await printer.confirmDispatchedJob(host, serial, token, safetyStatus(), "job", () => {}, silent), "unconfirmed");
  } finally { process.env.BAMBU_DISPATCH_CHECK_MS = "0"; }
});

const signedOnly = [["fun bit 29", { fun: "14023FF1AFFF9CB7" }], ["flag3 bit 4", { flag3: 31 }]];
for (const [flag, raw] of signedOnly) {
  test(`unsigned LAN 3MF print refuses a printer whose ${flag} says signed-only before upload`, async (t) => {
    const file = await fixture(t);
    const { printer, events } = isolatedPrinter(safetyStatus(raw));
    await assert.rejects(printer.print3mf(host, serial, token, { projectName: "signed", filePath: file, bambuModel: "p1s", useAMS: false }), /only takes signed commands[\s\S]*Nothing was uploaded or sent[\s\S]*BAMBU_UNSIGNED_LAN_PRINT/);
    assertNoDispatch(events);
  });
  test(`upload-and-print and remote start of raw G-code refuse a printer whose ${flag} says signed-only`, async (t) => {
    const file = await fixture(t, { raw: true });
    const { printer, events } = isolatedPrinter(safetyStatus(raw));
    await assert.rejects(printer.uploadFile(host, serial, token, file, "job.gcode", true, "p1s"), /only takes signed commands/);
    printer.ftpDownload = async (_host, _token, _remote, local) => { events.push({ action: "download" }); await fs.copyFile(file, local); };
    await assert.rejects(printer.startJob(host, serial, token, "job.gcode", "p1s"), /only takes signed commands/);
    assertNoDispatch(events);
  });
}

test("unsigned LAN prints go out where the printer doesn't require signing, or with the explicit opt-in", async (t) => {
  const file = await fixture(t);
  const unsigned = isolatedPrinter(safetyStatus({ fun: "1F" }));
  assert.equal((await unsigned.printer.print3mf(host, serial, token, { projectName: "plain", filePath: file, bambuModel: "p1s", useAMS: false })).dispatch, "unconfirmed");
  assert.equal(unsigned.events.filter(({ action }) => action === "publish").length, 1);
  process.env.BAMBU_UNSIGNED_LAN_PRINT = "1";
  t.after(() => { delete process.env.BAMBU_UNSIGNED_LAN_PRINT; });
  const optedIn = isolatedPrinter(safetyStatus({ fun: "14023FF1AFFF9CB7" }));
  await optedIn.printer.print3mf(host, serial, token, { projectName: "dev-mode", filePath: file, bambuModel: "p1s", useAMS: false });
  assert.equal(optedIn.events.filter(({ action }) => action === "publish").length, 1);
});

for (const [component, target, material] of [["nozzle", NaN, "PLA"], ["bed", Infinity, undefined], ["bed", 300, undefined], ["nozzle", 300, "PLA"], ["nozzle", 220, undefined]]) {
  test(`manual ${component} target ${String(target)} ${material ?? "without material"} rejects before connection`, async () => {
    const { printer, events } = isolatedPrinter();
    await assert.rejects(printer.setTemperature(host, serial, token, component, target, "p1s", material, 0.4), /temperature|finite|material|limit/i);
    assert.deepEqual(events, [], "invalid heater requests must not connect or publish");
  });
}

test("heater-off remains available without material or reported nozzle metadata", async () => {
  const { printer, events } = isolatedPrinter(safetyStatus({ nozzle: undefined }));
  const result = await printer.setTemperature(host, serial, token, "nozzle", 0);
  assert.equal(result.status, "success");
  assert.equal(events.filter(({ action }) => action === "publish").length, 1);
  assert.match(JSON.stringify(events.find(({ action }) => action === "publish").payload), /M104 S0/);
});

test("manual nozzle heating cannot relabel a loaded AMS PLA spool as PA", async () => {
  const { printer, events } = isolatedPrinter(safetyStatus({
    ams: { tray_now: "0", ams: [{ id: "0", tray: [{ id: "0", tray_type: "PLA", nozzle_temp_min: "190", nozzle_temp_max: "240" }] }] },
  }));
  await assert.rejects(printer.setTemperature(host, serial, token, "nozzle", 300, "p1s", "PA", 0.4), /material|contradict|PLA/i);
  assertNoDispatch(events);
});

test("manual nozzle heating accepts a declared external PA spool with matching telemetry", async () => {
  const { printer, events } = isolatedPrinter(safetyStatus({ ams: { tray_now: "254", ams: [] }, vt_tray: { tray_type: "PA", nozzle_temp_min: "250", nozzle_temp_max: "300" } }));
  const result = await printer.setTemperature(host, serial, token, "nozzle", 280, "p1s", "PA", 0.4);
  assert.equal(result.status, "success");
  const publishes = events.filter((event) => event.action === "publish");
  assert.equal(publishes.length, 1);
  assert.match(JSON.stringify(publishes[0].payload), /M104(?: T0)? S280/);
});

for (const route of ["legacy 3MF", "raw upload-and-print", "remote start"]) {
  test(`${route} rejects an explicitly unloaded nozzle before upload or dispatch`, async (t) => {
    const file = await fixture(t, { raw: route !== "legacy 3MF" });
    const { printer, events } = isolatedPrinter(safetyStatus({ ams: { tray_now: "255", ams: [] } }));
    printer.ftpDownload = async (_host, _token, _remote, destination) => fs.copyFile(file, destination);
    const print = route === "legacy 3MF"
      ? printer.print3mf(host, serial, token, { projectName: "unloaded", filePath: file, bambuModel: "p1s", useAMS: false })
      : route === "raw upload-and-print"
        ? printer.uploadFile(host, serial, token, file, "unloaded.gcode", true, "p1s")
        : printer.startJob(host, serial, token, "unloaded.gcode", "p1s");
    await assert.rejects(print, /no filament|unloaded|load.*filament/i);
    assertNoDispatch(events);
  });

  test(`${route} checks the loaded AMS material instead of an unused external-spool declaration`, async (t) => {
    const file = await fixture(t, { raw: route !== "legacy 3MF", material: "PA", gcode: "M104 S300\nM140 S60\nG1 X10 Y10 Z1\n" });
    const { printer, events } = isolatedPrinter(safetyStatus({
      ams: { tray_now: "0", ams: [{ id: "0", tray: [{ id: "0", tray_type: "PLA", nozzle_temp_min: "190", nozzle_temp_max: "240" }] }] },
      vt_tray: { tray_type: "PA", nozzle_temp_min: "250", nozzle_temp_max: "300" },
    }));
    printer.ftpDownload = async (_host, _token, _remote, destination) => fs.copyFile(file, destination);
    const print = route === "legacy 3MF"
      ? printer.print3mf(host, serial, token, { projectName: "wrong-loaded-material", filePath: file, bambuModel: "p1s", useAMS: false })
      : route === "raw upload-and-print"
        ? printer.uploadFile(host, serial, token, file, "wrong-material.gcode", true, "p1s")
        : printer.startJob(host, serial, token, "wrong-material.gcode", "p1s");
    await assert.rejects(print, /material|contradict|PLA|loaded/i);
    assertNoDispatch(events);
  });
}

test("remote start refuses an artifact that cannot be downloaded for inspection", async () => {
  const { printer, events } = isolatedPrinter();
  printer.ftpDownload = async () => { throw new Error("remote artifact unavailable for inspection"); };
  await assert.rejects(printer.startJob(host, serial, token, "uninspected.gcode", "p1s"), /inspect|download|unavailable/i);
  assertNoDispatch(events);
});

test("remote start rejects downloaded PLA at 400 C before reupload or print", async (t) => {
  const file = await fixture(t, { raw: true, gcode: "M104 S400\n" });
  const { printer, events } = isolatedPrinter();
  printer.ftpDownload = async (_host, _token, _remote, destination) => fs.copyFile(file, destination);
  await assert.rejects(printer.startJob(host, serial, token, "unsafe.gcode", "p1s"), /temperature|thermal|limit/i);
  assertNoDispatch(events);
});

test("remote start uploads and starts a uniquely named copy of the inspected download", async (t) => {
  const file = await fixture(t, { raw: true });
  const expected = await fs.readFile(file);
  const { printer, events } = isolatedPrinter();
  const downloads = [];
  printer.ftpDownload = async (targetHost, targetToken, remote, destination) => {
    downloads.push({ targetHost, targetToken, remote });
    await fs.copyFile(file, destination);
  };
  const result = await printer.startJob(host, serial, token, "old-job.gcode", "p1s");
  assert.equal(result.status, "dispatched_unconfirmed");
  assert.deepEqual(downloads, [{ targetHost: host, targetToken: token, remote: "cache/old-job.gcode" }]);
  const upload = events.find(({ action }) => action === "upload");
  assert.deepEqual(upload.bytes, expected);
  assert.match(upload.remote, /^\/cache\/checked-[a-f0-9-]+-old-job\.gcode$/);
  assert.match(JSON.stringify(events.find(({ action }) => action === "publish").payload), new RegExp(path.posix.basename(upload.remote).replaceAll(".", "\\.")));
});

test("resume refuses a job this server has not inspected before connecting", async () => {
  const { printer, events } = isolatedPrinter(safetyStatus({ state: "PAUSE" }));
  await assert.rejects(printer.resumeJob(host, serial, token), /inspect|server instance|verified/i);
  assert.deepEqual(events, []);
});

test("a matching inspected paused job can resume after a fresh safety check", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter();
  const started = await printer.print3mf(host, serial, token, { projectName: "resume", filePath: file, bambuModel: "p1s", useAMS: false });
  events.length = 0;
  printer.getSafetyStatus = async () => {
    events.push({ action: "status" });
    return safetyStatus({ state: "PAUSE", gcode_file: started.remoteProjectPath });
  };
  const result = await printer.resumeJob(host, serial, token);
  assert.equal(result.status, "success");
  assert.deepEqual(events.map(({ action }) => action), ["status", "connect", "publish"]);
  assert.equal(events[2].payload.print.command, "resume");
});

for (const [name, changes, error] of [
  ["a different paused job", { gcode_file: "cache/unverified.gcode", subtask_name: "another job" }, /identity|artifact|match/i],
  ["a changed nozzle", { nozzle: "0.6" }, /nozzle|diameter/i],
  ["a changed spool material", { vt_tray: { tray_type: "ABS" } }, /material|contradict/i],
  ["a job that is no longer paused", { state: "RUNNING" }, /paused|PAUSE|state/i],
  ["an explicitly unloaded nozzle", { ams: { tray_now: 255, ams: [] } }, /no filament|unloaded|load.*filament/i],
  ["a different loaded spool", { ams: { tray_now: "0", ams: [{ id: "0", tray: [{ id: "0", tray_type: "ABS" }] }] } }, /loaded.*tray|loaded.*spool/i],
  ["an unknown current AMS tray", { ams: { ams: [] } }, /loaded.*tray|loaded.*spool/i],
]) {
  test(`resume refuses ${name} without publishing`, async (t) => {
    const file = await fixture(t);
    const { printer, events } = isolatedPrinter();
    const started = await printer.print3mf(host, serial, token, { projectName: "resume", filePath: file, bambuModel: "p1s", useAMS: false });
    events.length = 0;
    printer.getSafetyStatus = async () => safetyStatus({ state: "PAUSE", gcode_file: started.remoteProjectPath, ...changes });
    await assert.rejects(printer.resumeJob(host, serial, token), error);
    assert.deepEqual(events, [], "rejected resume must not connect to publish a mutation");
  });
}

async function interceptedMcp(t, { blockBridgeInitialization = false, realBridgeRequest = false, model = "p1s", nozzleDiameters = [0.4], ams, bridgeResponse = { ok: true, value: 0 }, env = {}, afterPrint, printUncertain = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-bridge-safety-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const eventsPath = path.join(dir, "events.jsonl");
  const releasePath = path.join(dir, "release-agent");
  const statusPath = path.join(dir, "reported-status.json");
  const preload = path.join(dir, "boundaries.mjs");
  await fs.writeFile(preload, `
    import fs from 'node:fs';
    import { BambuImplementation } from ${JSON.stringify(pathToFileURL(path.join(root, "dist/printers/bambu.js")).href)};
    import { BambuNetworkBridge, BridgeDispatchUncertainError } from ${JSON.stringify(pathToFileURL(path.join(root, "dist/bambu-network-bridge.js")).href)};
    import { STLManipulator } from ${JSON.stringify(pathToFileURL(path.join(root, "dist/stl/stl-manipulator.js")).href)};
    const log = event => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + '\\n');
    // What the printer reports once a print request went out (B3 confirmation tests).
    let printSent = false;
    BambuImplementation.prototype.ftpUpload = async (_host, _token, file, remote) => log({action:'upload', file, remote});
    BambuImplementation.prototype.ftpDownload = async () => { throw new Error('Remote artifact unavailable for inspection'); };
    BambuImplementation.prototype.getPrinter = async () => ({publish: async payload => log({action:'publish', payload})});
    STLManipulator.prototype.sliceSTL = async () => { log({action:'slice'}); throw new Error('Test slicer must not be invoked'); };
    BambuImplementation.prototype.getSafetyStatus = async () => {
      const now = Date.now();
      const reported={...(fs.existsSync(${JSON.stringify(statusPath)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(statusPath)},'utf8')) : {}), ...(printSent ? ${JSON.stringify(afterPrint ?? {})} : {})};
      return {connected:true, model:${JSON.stringify(model)}, status:reported.gcode_state??'IDLE', serial:${JSON.stringify(serial)},
        raw:{model:${JSON.stringify(model)},gcode_state:'IDLE',nozzle_diameter:${JSON.stringify(String(nozzleDiameters[0]))},device:{nozzle:{info:${JSON.stringify(nozzleDiameters.map((diameter, id) => ({ id, diameter, type: "HH01", stat: 0 })))}}},print_error:0,hms:[],...${JSON.stringify(ams ? { ams } : {})},...reported},
        observation:{source:'mqtt',requestedAt:now,receivedAt:now,fullAt:now,identitySource:'report'}};
    };
    BambuNetworkBridge.prototype.ensurePrinterChannel = async (devId) => { log({ action: 'bridge-channel', devId }); };
    BambuNetworkBridge.prototype.ensureLocalChannel = async (devId, devIp) => { log({ action: 'bridge-local-channel', devId, devIp }); };
    BambuNetworkBridge.prototype.ensureAgent = async () => {
      ${blockBridgeInitialization ? `log({action:'agent-wait'}); while (!fs.existsSync(${JSON.stringify(releasePath)})) await new Promise(resolve => setTimeout(resolve,10));` : ""}
      return { agent: 0, handshake: { ok: true } };
    };
    ${realBridgeRequest ? `BambuNetworkBridge.prototype.ensureStarted = async function () {
      this.child = {exitCode:0, stdin:{write:(frame, callback) => {
        const message=JSON.parse(frame.subarray(16).toString('utf8'));
        log({action:'bridge-frame',...message});
        const payload=Buffer.from(JSON.stringify(${JSON.stringify(bridgeResponse)}));
        const response=Buffer.alloc(16+payload.length);
        response.writeUInt32LE(0x52424a50,0); response.writeUInt32LE(2,4);
        response.writeUInt32LE(frame.readUInt32LE(8),8); response.writeUInt32LE(payload.length,12); payload.copy(response,16);
        queueMicrotask(()=>this.handleStdout(response)); callback?.(); return true;
      }}};
    };` : `BambuNetworkBridge.prototype.request = async (method, payload) => {
      log({ action:'bridge', method, payload });
      if (method.startsWith('net.start_')) {
        printSent = true;
        ${printUncertain ? "throw new BridgeDispatchUncertainError(method, 'it did not answer within 1200 s (a cancel was requested)');" : ""}
      }
      return ${JSON.stringify(bridgeResponse)};
    };`}
  `);
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", preload, path.join(root, "dist/index.js")], cwd: dir, stderr: "pipe", env: { ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "", BAMBU_PRINTER_MODEL: "", BAMBU_PRINTER_HOST: host, BAMBU_PRINTER_SERIAL: serial, BAMBU_SERIAL: serial, BAMBU_PRINTER_ACCESS_TOKEN: token, BAMBU_TOKEN: token, BAMBU_DEV_ID: serial, BAMBU_NETWORK_BRIDGE_COMMAND: "", BAMBU_DEFAULT_CONNECTION_MODE: "", ...env } });
  const client = new Client({ name: "safety-dispatch-tests", version: "1" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { confirmed: true } }));
  t.after(() => client.close());
  await client.connect(transport);
  return { client, eventsPath, releaseAgent: () => fs.writeFile(releasePath, "release"), setReportedStatus: reported => fs.writeFile(statusPath, JSON.stringify(reported)) };
}

const bridgeMode = { BAMBU_DEFAULT_CONNECTION_MODE: "bambu_network", BAMBU_NETWORK_BRIDGE_COMMAND: "fake-bridge" };
const readEvents = async eventsPath => (await fs.readFile(eventsPath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse);

test("signed AMS drying checks a fresh report, then sends Studio's payload through the bridge", async (t) => {
  const server = await interceptedMcp(t, { env: bridgeMode });
  const start = { action: "start", ams_id: 128, filament: "PETG", temperature: 65, duration_hours: 8, cooling_temperature: 60 };
  await server.setReportedStatus({ fun2: "E", ams: { ams: [{ id: "128", info: "2004", dry_sf_reason: [] }] } });
  const refused = await server.client.callTool({ name: "set_ams_drying", arguments: start });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /fun2 bit 5/);
  assert.ok(!(await readEvents(server.eventsPath)).some(event => event.method === "net.send_message"), "a refused start sends nothing");
  await server.setReportedStatus({ fun2: "B7B77", ams: { ams: [{ id: "128", info: "2004", dry_sf_reason: [] }] } });
  const started = await server.client.callTool({ name: "set_ams_drying", arguments: start });
  assert.notEqual(started.isError, true, started.content?.[0]?.text);
  const sent = (await readEvents(server.eventsPath)).filter(event => event.method === "net.send_message").map(event => JSON.parse(event.payload.msg));
  assert.equal(sent.length, 1);
  const { sequence_id, ...print } = sent[0].print;
  assert.match(sequence_id, /^\d+$/);
  assert.deepEqual(print, { command: "ams_filament_drying", ams_id: 128, mode: 1, filament: "PETG", temp: 65, duration: 8, humidity: 0, rotate_tray: false, cooling_temp: 60, close_power_conflict: false });
});

test("with the bridge as default, print_3mf lan_mqtt_ftps goes through the signed bridge, not unsigned MQTT", async (t) => {
  const server = await interceptedMcp(t, { env: bridgeMode });
  const file = await fixture(t);
  const result = await server.client.callTool({ name: "print_3mf", arguments: { three_mf_path: file, bambu_model: "p1s", bed_type: "textured_plate", use_ams: false, connection_mode: "lan_mqtt_ftps" } });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  const events = await readEvents(server.eventsPath);
  assert.deepEqual(events.filter(event => event.action === "publish" || event.action === "upload"), [], "no unsigned MQTT print or FTPS upload");
  assert.ok(events.some(event => event.method === "net.start_print"), "the bridge carries the print");
  assert.equal(JSON.parse(result.content[0].text).routedFrom, "lan_mqtt_ftps");
});

for (const [name, afterPrint, status, dispatch] of [
  ["the printer reports the job running", { gcode_state: "RUNNING" }, "success", "started"],
  ["the printer runs a different job", { gcode_state: "RUNNING", subtask_name: "someone else's part" }, "dispatched_unconfirmed", "unconfirmed"],
  ["the printer stays idle", {}, "dispatched_unconfirmed", "unconfirmed"],
]) test(`a bridge print returning 0 is confirmed from the printer: ${name}`, async (t) => {
  const server = await interceptedMcp(t, { afterPrint, env: { BAMBU_DISPATCH_CHECK_MS: "3500" } });
  const file = await fixture(t);
  const result = await server.client.callTool({ name: "print_3mf_bambu_network", arguments: { three_mf_path: file, bambu_model: "p1s", bed_type: "textured_plate", use_ams: false, connection_type: "cloud" } });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.status, status);
  assert.equal(body.dispatch, dispatch);
  if (dispatch === "unconfirmed") assert.match(body.message, /has not reported starting.*do not send it again/i);
  assert.equal((await readEvents(server.eventsPath)).filter(event => event.method === "net.start_print").length, 1);
});

test("a bridge print the printer reports FAILED for is an error, not a success", async (t) => {
  const server = await interceptedMcp(t, { afterPrint: { gcode_state: "FAILED", print_error: 0x0500400e }, env: { BAMBU_DISPATCH_CHECK_MS: "3500" } });
  const result = await server.client.callTool({ name: "print_3mf_bambu_network", arguments: { three_mf_path: await fixture(t), bambu_model: "p1s", bed_type: "textured_plate", use_ams: false, connection_type: "cloud" } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /print error 0500400E/);
});

for (const [name, options] of [
  ["a bridge print that times out after dispatch", { printUncertain: true }],
  ["a cloud task the printer didn't acknowledge (-3130)", { bridgeResponse: { ok: true, value: -3130 } }],
]) test(`${name} is never resent and is reported as possibly started`, async (t) => {
  const server = await interceptedMcp(t, { ...options, env: { BAMBU_DISPATCH_CHECK_MS: "0" } });
  const result = await server.client.callTool({ name: "print_3mf_bambu_network", arguments: { three_mf_path: await fixture(t), bambu_model: "p1s", bed_type: "textured_plate", use_ams: false, connection_type: "cloud" } });
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.message, /may still (?:upload and )?start.*Do not send it again/s);
  assert.match(result.structuredContent.suggestion, /^Do not retry/);
  assert.equal((await readEvents(server.eventsPath)).filter(event => event.method === "net.start_print").length, 1, "sent exactly once");
});

test("a bridge print that timed out but the printer runs is reported as started, not resent", async (t) => {
  const server = await interceptedMcp(t, { printUncertain: true, afterPrint: { gcode_state: "PREPARE" }, env: { BAMBU_DISPATCH_CHECK_MS: "3500" } });
  const result = await server.client.callTool({ name: "print_3mf_bambu_network", arguments: { three_mf_path: await fixture(t), bambu_model: "p1s", bed_type: "textured_plate", use_ams: false, connection_type: "cloud" } });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.dispatch, "started");
  assert.match(body.message, /did not answer.*not sent again/);
  assert.equal((await readEvents(server.eventsPath)).filter(event => event.method === "net.start_print").length, 1);
});

test("raw BambuNetwork start_print cannot bypass the inspected print handler", async (t) => {
  const { client, eventsPath } = await interceptedMcp(t);
  const result = await client.callTool({ name: "bambu_network_call", arguments: { method: "net.start_print", with_agent: false, payload: { client_job_id: 0, params: { filename: "uninspected.gcode" } } } });
  assert.equal(result.isError, true);
  assert.match(result.content.map((item) => item.text ?? "").join(" "), /safety|print_3mf_bambu_network|inspect|not allowed|disabled/i);
  await assert.rejects(fs.access(eventsPath), { code: "ENOENT" }, "raw mutation must be rejected before invoking the bridge");
});

test("public print and heating tools enforce safety before their transport boundaries", async (t) => {
  const { client, eventsPath } = await interceptedMcp(t);
  const unsafe3mf = await fixture(t, { gcode: "M104 S400\n" });
  const unsafeGcode = await fixture(t, { raw: true, gcode: "M140 S300\n" });
  const safe3mf = await fixture(t);
  for (const [name, args, expected] of [
    ["print_3mf", { three_mf_path: unsafe3mf, bambu_model: "p1s", bed_type: "textured_plate", use_ams: false }, /temperature|thermal|limit/i],
    ["upload_file", { file_path: unsafeGcode, filename: "unsafe.gcode", print: true, bambu_model: "p1s" }, /temperature|thermal|limit/i],
    ["start_print", { filename: "uninspected.gcode", bambu_model: "p1s" }, /inspect|download|unavailable/i],
    ["start_print_job", { filename: "uninspected.gcode", bambu_model: "p1s" }, /inspect|download|unavailable/i],
    ["print_3mf_bambu_network", { three_mf_path: unsafe3mf, bambu_model: "p1s", bed_type: "textured_plate", ams_slots: [0], connection_type: "cloud" }, /temperature|thermal|limit/i],
    ["print_3mf_bambu_network", { three_mf_path: safe3mf, bambu_model: "p1s", bed_type: "textured_plate", plate_index: 98, ams_slots: [0], connection_type: "cloud" }, /plate/i],
    ["set_temperature", { component: "nozzle", temperature: "not-a-number", bambu_model: "p1s", material: "PLA" }, /number|finite|temperature/i],
    ["set_temperature", { component: "bed", temperature: 300, bambu_model: "p1s" }, /temperature|limit/i],
  ]) {
    await t.test(`${name} rejects ${JSON.stringify(args)}`, async () => {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      assert.match(result.content.map((item) => item.text ?? "").join(" "), expected);
      await assert.rejects(fs.access(eventsPath), { code: "ENOENT" }, "rejected public request must not upload, publish, or invoke bridge");
    });
  }
});

test("verified public direct and bridge prints reach their intended transport", async (t) => {
  const { client, eventsPath } = await interceptedMcp(t);
  const file = await fixture(t);
  const direct = await client.callTool({ name: "print_3mf", arguments: { three_mf_path: file, bambu_model: "p1s", nozzle_diameter: "0.4", bed_type: "textured_plate", use_ams: false } });
  assert.notEqual(direct.isError, true, direct.content?.[0]?.text);
  const directEvents = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(directEvents.map(({ action }) => action), ["upload", "publish"]);
  assert.equal(directEvents[1].payload.print.command, "gcode_file");
  assert.equal(directEvents[1].payload.print.param, directEvents[0].remote.slice(1));

  await fs.writeFile(eventsPath, "");
  const bridge = await client.callTool({ name: "print_3mf_bambu_network", arguments: { three_mf_path: file, bambu_model: "p1s", nozzle_diameter: "0.4", bed_type: "textured_plate", use_ams: false, connection_type: "cloud" } });
  assert.notEqual(bridge.isError, true, bridge.content?.[0]?.text);
  const bridgeEvents = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  const print = bridgeEvents.find((event) => event.method === "net.start_print");
  assert.ok(print, "verified bridge handler must issue net.start_print");
  assert.equal(print.payload.params.plate_index, 1, "bridge uses one-based plate numbers");
  assert.notEqual(print.payload.params.filename, file, "bridge must consume the checked private copy");
  assert.match(print.payload.params.dst_file, /^checked-[a-f0-9-]+-job\.gcode\.3mf$/);
  assert.equal(print.payload.params.task_use_ams, false);
  assert.equal(print.payload.params.ams_mapping, "[254]");
  // Studio's bed string and P1S options: leveling on (1), no flow calibration, vibration off, first-layer inspection on.
  const { task_bed_type, task_bed_leveling, auto_bed_leveling, task_flow_cali, auto_flow_cali, auto_offset_cali, task_vibration_cali, task_layer_inspect } = print.payload.params;
  assert.deepEqual({ task_bed_type, task_bed_leveling, auto_bed_leveling, task_flow_cali, auto_flow_cali, auto_offset_cali, task_vibration_cali, task_layer_inspect },
    { task_bed_type: "textured_plate", task_bed_leveling: true, auto_bed_leveling: 1, task_flow_cali: false, auto_flow_cali: 0, auto_offset_cali: 0, task_vibration_cali: false, task_layer_inspect: true });
  // Studio's per-model ftp_folder ("sdcard/" on the P1 series); single-nozzle jobs send no nozzles_info.
  assert.equal(print.payload.params.ftp_folder, "sdcard/");
  assert.equal(print.payload.params.nozzles_info, "");
});

async function startBridgeJob(t, options) {
  const server = await interceptedMcp(t, { realBridgeRequest: true, ...options });
  const file = await fixture(t);
  const result = await server.client.callTool({ name: "print_3mf_bambu_network", arguments: { three_mf_path: file, bambu_model: "p1s", bed_type: "textured_plate", use_ams: false, connection_type: "cloud" } });
  const events = (await fs.readFile(server.eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  const params = events.find(event => event.action === "bridge-frame" && event.method === "net.start_print")?.payload.params;
  assert.ok(params, "the bridge job must reach the native request boundary");
  return { ...server, result, params };
}

for (const identityField of ["gcode_file", "subtask_name"]) {
  test(`a verified bridge job resumes when fresh ${identityField} identifies its unique artifact`, async (t) => {
    const server = await startBridgeJob(t);
    assert.notEqual(server.result.isError, true, server.result.content?.[0]?.text);
    assert.match(server.params.task_name, /^checked-[a-f0-9-]+-job/);
    const reportedName = identityField === "gcode_file" ? server.params.dst_file : server.params.task_name;
    await server.setReportedStatus({ gcode_state: "PAUSE", [identityField]: reportedName });
    await fs.writeFile(server.eventsPath, "");
    const resumed = await server.client.callTool({ name: "resume_print", arguments: {} });
    assert.notEqual(resumed.isError, true, resumed.content?.[0]?.text);
    const events = (await fs.readFile(server.eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(events.map(event => event.action), ["publish"]);
    assert.equal(events[0].payload.print.command, "resume");
  });
}

for (const [description, changedReport, expected] of [
  ["a different paused job", { gcode_file: "unverified.gcode", subtask_name: "other project" }, /identity|artifact|match/i],
  ["a changed physical nozzle", { nozzle_diameter: "0.6", device: { nozzle: { info: [{ id: 0, diameter: 0.6, type: "HH01", stat: 0 }] } } }, /nozzle|diameter/i],
]) {
  test(`bridge-job resume refuses ${description}`, async (t) => {
    const server = await startBridgeJob(t);
    assert.notEqual(server.result.isError, true, server.result.content?.[0]?.text);
    await server.setReportedStatus({ gcode_state: "PAUSE", gcode_file: server.params.dst_file, ...changedReport });
    await fs.writeFile(server.eventsPath, "");
    const resumed = await server.client.callTool({ name: "resume_print", arguments: {} });
    assert.equal(resumed.isError, true);
    assert.match(resumed.content?.[0]?.text ?? "", expected);
    assert.equal(await fs.readFile(server.eventsPath, "utf8"), "", "a failed resume must not publish or dispatch");
  });
}

test("a rejected bridge start cannot authorize a later resume", async (t) => {
  const server = await startBridgeJob(t, { bridgeResponse: { ok: true, value: -1 } });
  assert.equal(server.result.isError, true);
  await server.setReportedStatus({ gcode_state: "PAUSE", gcode_file: server.params.dst_file });
  await fs.writeFile(server.eventsPath, "");
  const resumed = await server.client.callTool({ name: "resume_print", arguments: {} });
  assert.equal(resumed.isError, true);
  assert.match(resumed.content?.[0]?.text ?? "", /inspected|server instance|verified/i);
  assert.equal(await fs.readFile(server.eventsPath, "utf8"), "", "failed submission cannot leave a resumable job receipt");
});

test("public print schemas expose ordered nozzle diameter arrays", async (t) => {
  const { client } = await interceptedMcp(t);
  const { tools } = await client.listTools();
  for (const name of ["print_3mf", "print_3mf_bambu_network"]) {
    const schema = tools.find(tool => tool.name === name)?.inputSchema;
    assert.equal(schema?.properties?.nozzle_diameters?.type, "array", `${name} must accept per-nozzle diameters`);
    assert.equal(schema.properties.nozzle_diameters.items.type, "number");
  }
});

// The printer reports nozzles by physical id (0 = right, 1 = left); sliced files list the left nozzle first. So a
// left 0.4 / right 0.6 job is reported as [id 0: 0.6, id 1: 0.4].
for (const tool of ["print_3mf", "print_3mf_bambu_network"]) {
  for (const [description, nozzleArgs] of [
    ["explicit ordered nozzle diameters", { nozzle_diameters: [0.4, 0.6] }],
    ["job metadata when no nozzle argument is supplied", {}],
  ]) {
    test(`${tool} accepts mixed H2D nozzles using ${description}`, async (t) => {
      const { client, eventsPath } = await interceptedMcp(t, { model: "h2d", nozzleDiameters: [0.6, 0.4], realBridgeRequest: true });
      const file = await fixture(t, { model: "h2d", nozzleDiameters: [0.4, 0.6] });
      const result = await client.callTool({ name: tool, arguments: { three_mf_path: file, bambu_model: "h2d", bed_type: "textured_plate", use_ams: false, ...nozzleArgs } });
      assert.notEqual(result.isError, true, result.content?.[0]?.text);
      const events = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
      if (tool === "print_3mf") {
        assert.deepEqual(events.map(event => event.action), ["upload", "publish"]);
        assert.equal(events[1].payload.print.command, "project_file");
        assert.equal(events[1].payload.print.param, "Metadata/plate_1.gcode");
      } else {
        assert.equal(events.filter(event => event.action === "bridge-frame" && event.method === "net.start_print").length, 1);
      }
    });
  }

  test(`${tool} accepts mixed H2D nozzles with a verified AMS mapping`, async (t) => {
    const { client, eventsPath } = await interceptedMcp(t, {
      model: "h2d", nozzleDiameters: [0.6, 0.4], realBridgeRequest: true,
      ams: { tray_now: "0", ams: [{ id: "0", tray: [{ id: "0", tray_type: "PLA", nozzle_temp_min: "190", nozzle_temp_max: "240" }] }] },
    });
    const file = await fixture(t, { model: "h2d", nozzleDiameters: [0.4, 0.6] });
    const result = await client.callTool({ name: tool, arguments: { three_mf_path: file, bambu_model: "h2d", nozzle_diameters: [0.4, 0.6], bed_type: "textured_plate", ams_slots: [0] } });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    const events = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
    if (tool === "print_3mf") {
      assert.deepEqual(events.find(event => event.action === "publish")?.payload.print.ams_mapping, [0]);
    } else {
      assert.equal(events.find(event => event.action === "bridge-frame" && event.method === "net.start_print")?.payload.params.ams_mapping, "[0]");
    }
  });

  for (const [description, nozzleArgs] of [
    ["an explicit scalar that does not match every nozzle", { nozzle_diameter: "0.4" }],
    ["an array with the nozzle positions reversed", { nozzle_diameters: [0.6, 0.4] }],
  ]) {
    test(`${tool} rejects ${description}`, async (t) => {
      const { client, eventsPath } = await interceptedMcp(t, { model: "h2d", nozzleDiameters: [0.6, 0.4] });
      const file = await fixture(t, { model: "h2d", nozzleDiameters: [0.4, 0.6] });
      const result = await client.callTool({ name: tool, arguments: { three_mf_path: file, bambu_model: "h2d", ...nozzleArgs, bed_type: "textured_plate", use_ams: false } });
      assert.equal(result.isError, true);
      assert.match(result.content?.[0]?.text ?? "", /nozzle|diameter/i);
      await assert.rejects(fs.access(eventsPath), { code: "ENOENT" });
    });
  }

  test(`${tool} rejects a mixed H2D file when the live second nozzle differs`, async (t) => {
    const { client, eventsPath } = await interceptedMcp(t, { model: "h2d", nozzleDiameters: [0.8, 0.4], realBridgeRequest: true });
    const file = await fixture(t, { model: "h2d", nozzleDiameters: [0.4, 0.6] });
    const result = await client.callTool({ name: tool, arguments: { three_mf_path: file, bambu_model: "h2d", nozzle_diameters: [0.4, 0.6], bed_type: "textured_plate", use_ams: false } });
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? "", /nozzle.*1.*diameter|nozzle.*match/i);
    await assert.rejects(fs.access(eventsPath), { code: "ENOENT" });
  });

  test(`${tool} rejects conflicting scalar and array nozzle arguments`, async (t) => {
    const { client, eventsPath } = await interceptedMcp(t, { model: "h2d", nozzleDiameters: [0.6, 0.4] });
    const file = await fixture(t, { model: "h2d", nozzleDiameters: [0.4, 0.6] });
    const result = await client.callTool({ name: tool, arguments: { three_mf_path: file, bambu_model: "h2d", nozzle_diameter: "0.4", nozzle_diameters: [0.4, 0.6], bed_type: "textured_plate", use_ams: false } });
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? "", /both|conflict|one of|either/i);
    await assert.rejects(fs.access(eventsPath), { code: "ENOENT" });
  });

  test(`${tool} rejects mixed-nozzle auto-slicing before the slicer or printer is invoked`, async (t) => {
    const { client, eventsPath } = await interceptedMcp(t, { model: "h2d", nozzleDiameters: [0.6, 0.4] });
    const file = await fixture(t, { model: "h2d", nozzleDiameters: [0.4, 0.6] });
    const zip = await JSZip.loadAsync(await fs.readFile(file));
    zip.remove("Metadata/plate_1.gcode");
    await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
    const result = await client.callTool({ name: tool, arguments: { three_mf_path: file, bambu_model: "h2d", nozzle_diameters: [0.4, 0.6], bed_type: "textured_plate", use_ams: false } });
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? "", /mixed|pre-sliced|already.sliced/i);
    await assert.rejects(fs.access(eventsPath), { code: "ENOENT" });
  });
}

function bridgeWithCapturedFrames(t, beforeStartup = async () => {}) {
  const bridge = new BambuNetworkBridge();
  const frames = [];
  bridge.ensureStarted = async () => {
    await beforeStartup();
    bridge.child = { exitCode: 0, stdin: { write(frame, callback) {
      frames.push(JSON.parse(frame.subarray(16).toString("utf8")));
      const payload = Buffer.from(JSON.stringify({ ok: true, value: 0 }));
      const response = Buffer.alloc(16 + payload.length);
      response.writeUInt32LE(0x52424a50, 0);
      response.writeUInt32LE(2, 4);
      response.writeUInt32LE(frame.readUInt32LE(8), 8);
      response.writeUInt32LE(payload.length, 12);
      payload.copy(response, 16);
      queueMicrotask(() => bridge.handleStdout(response));
      callback?.();
      return true;
    } } };
  };
  t.after(() => bridge.stop());
  return { bridge, frames };
}

test("a bridge print request that gets no answer after its frame went out is uncertain, and asks the host to cancel", async (t) => {
  const bridge = new BambuNetworkBridge();
  const frames = [];
  bridge.ensureStarted = async () => {
    bridge.child = { exitCode: 0, stdin: { write(frame, callback) { frames.push(JSON.parse(frame.subarray(16).toString("utf8")).method); callback?.(); return true; } } };
  };
  t.after(() => bridge.stop());
  const error = await bridge.request("net.start_print", { client_job_id: 42, params: {} }, { timeoutMs: 50 }).catch(e => e);
  assert.equal(error.name, "BridgeDispatchUncertainError");
  assert.match(error.message, /may still upload and start.*Do not send it again/s);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(frames, ["net.start_print", "bridge.job_cancel"]);
  // Ordinary calls keep their plain timeout.
  await assert.rejects(bridge.request("net.is_user_login", {}, { timeoutMs: 20 }), /^Error: Timed out waiting/);
  // A print still in flight when the bridge exits is uncertain too.
  const pending = bridge.request("net.start_local_print", { client_job_id: 43 }, { timeoutMs: 5000 });
  while (frames.length < 4) await new Promise(resolve => setTimeout(resolve, 5));
  bridge.rejectAllPending(new Error("FULU BambuNetwork bridge exited (code=1, signal=null)."));
  await assert.rejects(pending, error => error.name === "BridgeDispatchUncertainError" && /bridge exited/.test(error.message));
});

test("bridge request checks fresh state after process startup and before writing a frame", async (t) => {
  let completeStartup;
  let startupEntered;
  const waiting = new Promise(resolve => { startupEntered = resolve; });
  const startupGate = new Promise(resolve => { completeStartup = resolve; });
  const { bridge, frames } = bridgeWithCapturedFrames(t, async () => { startupEntered(); await startupGate; });
  let state = "IDLE";
  const request = bridge.request("net.start_print", {}, {
    beforeDispatch: async () => { if (state !== "IDLE") throw new Error("Fresh printer state is RUNNING"); },
    timeoutMs: 1000,
  });
  const rejected = assert.rejects(request, /RUNNING/);
  await waiting;
  state = "RUNNING";
  completeStartup();
  await rejected;
  assert.deepEqual(frames, [], "no print frame may be written after startup invalidates the observed state");
});

test("bridge request checks cancellation after awaited preflight immediately before frame write", async (t) => {
  const { bridge, frames } = bridgeWithCapturedFrames(t);
  let releasePreflight;
  let preflightEntered;
  const waiting = new Promise(resolve => { preflightEntered = resolve; });
  const preflightGate = new Promise(resolve => { releasePreflight = resolve; });
  let cancelled = false;
  const request = bridge.request("net.start_print", {}, {
    beforeDispatch: async () => { preflightEntered(); await preflightGate; },
    assertDispatchAllowed: () => { if (cancelled) throw new Error("Print cancelled"); },
    timeoutMs: 1000,
  });
  const rejected = assert.rejects(request, /cancelled/);
  await waiting;
  cancelled = true;
  releasePreflight();
  await rejected;
  assert.deepEqual(frames, [], "cancellation during async preflight must stop the actual frame write");
});

test("bridge request writes a valid frame after both preflight hooks allow dispatch", async (t) => {
  const { bridge, frames } = bridgeWithCapturedFrames(t);
  const checks = [];
  const result = await bridge.request("net.start_print", { agent: 7, params: { plate_index: 1 } }, {
    beforeDispatch: async method => { checks.push(["fresh-state", method]); },
    assertDispatchAllowed: method => { checks.push(["cancellation", method]); },
    onDispatched: method => { checks.push(["dispatched", method]); },
    timeoutMs: 1000,
  });
  assert.deepEqual(result, { ok: true, value: 0 });
  assert.deepEqual(checks, [["fresh-state", "net.start_print"], ["cancellation", "net.start_print"], ["dispatched", "net.start_print"]]);
  assert.deepEqual(frames, [{ method: "net.start_print", payload: { agent: 7, params: { plate_index: 1 } } }]);
});

test("public stop during bridge agent initialization prevents the actual native print frame", async (t) => {
  const { client, eventsPath, releaseAgent } = await interceptedMcp(t, { blockBridgeInitialization: true, realBridgeRequest: true });
  const file = await fixture(t);
  const pending = client.callTool({ name: "print_3mf_bambu_network", arguments: { three_mf_path: file, bambu_model: "p1s", nozzle_diameter: "0.4", bed_type: "textured_plate", use_ams: false, connection_type: "lan" } });
  try {
    const deadline = Date.now() + 5000;
    while (!(await fs.readFile(eventsPath, "utf8").catch(() => "")).includes('"agent-wait"')) {
      assert.ok(Date.now() < deadline, "bridge initialization gate must be reached");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const stopped = await client.callTool({ name: "cancel_print", arguments: {} });
    assert.notEqual(stopped.isError, true, stopped.content?.[0]?.text);
  } finally {
    await releaseAgent();
  }
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(result.content.map(item => item.text ?? "").join(" "), /cancelled|canceled|stop/i);
  const events = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.filter(event => event.action === "publish" && event.payload?.print?.command === "stop").length, 1);
  assert.equal(events.filter(event => event.action === "bridge-frame").length, 0, "the real bridge request must stop before stdin.write");
});

test("human preflight declines before upload and shows inspected settings", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter();
  const prompts = [];
  printer.confirm = async message => { prompts.push(message); return false; };
  await assert.rejects(printer.print3mf(host, serial, token, { projectName: "confirm", filePath: file, bambuModel: "p1s", useAMS: false }), /confirmation.*declined/i);
  assertNoDispatch(events);
  assert.match(prompts[0], /P1S.*0\.4 mm.*PLA.*220°C.*60°C.*SHA-256/s);
});

test("human preflight rechecks printer state after confirmation", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter();
  printer.confirm = async () => { printer.getSafetyStatus = async () => safetyStatus({ state: "RUNNING" }); return true; };
  await assert.rejects(printer.print3mf(host, serial, token, { projectName: "confirm", filePath: file, bambuModel: "p1s", useAMS: false }), /not safely idle/i);
  assertNoDispatch(events);
});

test("FINISH asks a person to confirm bed clearance when confirmation is on", async (t) => {
  const previous = process.env.BAMBU_REQUIRE_CONFIRMATION;
  process.env.BAMBU_REQUIRE_CONFIRMATION = "1";
  t.after(() => { if (previous === undefined) delete process.env.BAMBU_REQUIRE_CONFIRMATION; else process.env.BAMBU_REQUIRE_CONFIRMATION = previous; });
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter(safetyStatus({ state: "FINISH", subtask_name: "previous-part" }));
  const prompts = [];
  printer.confirm = async message => { prompts.push(message); return false; };
  await assert.rejects(printer.print3mf(host, serial, token, { projectName: "confirm", filePath: file, bambuModel: "p1s", useAMS: false }), /confirmation.*declined/i);
  assert.match(prompts[0], /FINISH.*remove the previous part/i);
  assertNoDispatch(events);
});

test("unattended by default: checked prints, error clears and heating run without asking anyone", async (t) => {
  const previous = process.env.BAMBU_REQUIRE_CONFIRMATION;
  delete process.env.BAMBU_REQUIRE_CONFIRMATION;
  t.after(() => { if (previous === undefined) delete process.env.BAMBU_REQUIRE_CONFIRMATION; else process.env.BAMBU_REQUIRE_CONFIRMATION = previous; });
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter(safetyStatus({ state: "FINISH", subtask_name: "previous-part", print_error: 123 }));
  const prompts = [];
  printer.confirm = async message => { prompts.push(message); return false; };
  await printer.clearHmsErrors(host, serial, token);
  printer.getSafetyStatus = async () => safetyStatus({ state: "FINISH", subtask_name: "previous-part" });
  const result = await printer.print3mf(host, serial, token, { projectName: "agent", filePath: file, bambuModel: "p1s", useAMS: false });
  assert.deepEqual(prompts, [], "no prompt without BAMBU_REQUIRE_CONFIRMATION=1");
  assert.equal(result.status, "dispatched_unconfirmed");
  const upload = events.find(({ action }) => action === "upload");
  assert.ok(upload, "the checked file was uploaded");
  assert.match(JSON.stringify(events.filter(({ action }) => action === "publish").at(-1).payload), new RegExp(path.posix.basename(upload.remote).replaceAll(".", "\\.")));
  // Safety checks still run: a printer that is busy is refused without asking.
  printer.getSafetyStatus = async () => safetyStatus({ state: "RUNNING" });
  await assert.rejects(printer.print3mf(host, serial, token, { projectName: "busy", filePath: file, bambuModel: "p1s", useAMS: false }), /not safely idle/i);
  assert.deepEqual(prompts, []);
});

test("a stopped job (FAILED) asks for bed clearance like FINISH when confirmation is on", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter(safetyStatus({ state: "FAILED", subtask_name: "stopped-part" }));
  const prompts = [];
  printer.confirm = async message => { prompts.push(message); return false; };
  await assert.rejects(printer.print3mf(host, serial, token, { projectName: "after-stop", filePath: file, bambuModel: "p1s", useAMS: false }), /confirmation.*declined/i);
  assert.match(prompts[0], /FAILED.*remove the previous part/i);
  assertNoDispatch(events);
});

test("bed clearance cannot authorize a different finished job", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter(safetyStatus({ state: "FINISH", subtask_name: "previous-part" }));
  printer.confirm = async () => { printer.getSafetyStatus = async () => safetyStatus({ state: "FINISH", subtask_name: "another-part" }); return true; };
  await assert.rejects(printer.print3mf(host, serial, token, { projectName: "confirm", filePath: file, bambuModel: "p1s", useAMS: false }), /newly finished job/i);
  assertNoDispatch(events);
});

test("manual positive heating requires confirmation but heater-off does not", async () => {
  const { printer, events } = isolatedPrinter();
  printer.confirm = async () => false;
  await assert.rejects(printer.setTemperature(host, serial, token, "nozzle", 220, "p1s", "PLA"), /confirmation.*declined/i);
  assertNoDispatch(events);
  await printer.setTemperature(host, serial, token, "nozzle", 0);
  assert.match(events.find(event => event.action === "publish").payload.print.param, /M104 S0/);
});

test("hardware errors cannot be cleared without human confirmation", async () => {
  const { printer, events } = isolatedPrinter(safetyStatus({ print_error: 123, hms: [{ attr: 1, code: 0x20001 }] }));
  const prompts = [];
  printer.confirm = async message => { prompts.push(message); return false; };
  await assert.rejects(printer.clearHmsErrors(host, serial, token), /confirmation.*declined/i);
  assert.match(prompts[0], /print_error:123.*hms:1:131073|hms:1:131073.*print_error:123/);
  assertNoDispatch(events);
});

test("cleared hardware codes are returned and acknowledged again before printing", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter(safetyStatus({ print_error: 123, hms: [] }));
  const cleared = await printer.clearHmsErrors(host, serial, token);
  assert.deepEqual(cleared.cleared_codes, ["print_error:123"]);
  events.length = 0;
  printer.getSafetyStatus = async () => safetyStatus();
  const prompts = [];
  printer.confirm = async message => { prompts.push(message); return false; };
  await assert.rejects(printer.print3mf(host, serial, token, { projectName: "confirm", filePath: file, bambuModel: "p1s", useAMS: false }), /confirmation.*declined/i);
  assert.match(prompts[0], /Previously cleared hardware codes: print_error:123/);
  assertNoDispatch(events);
});

test("changed hardware codes during confirmation are not cleared", async () => {
  const { printer, events } = isolatedPrinter(safetyStatus({ print_error: 123, hms: [] }));
  printer.confirm = async () => { printer.getSafetyStatus = async () => safetyStatus({ print_error: 456, hms: [] }); return true; };
  await assert.rejects(printer.clearHmsErrors(host, serial, token), /errors changed/i);
  assertNoDispatch(events);
});

for (const failure of ["confirmation recheck", "upload", "dispatch recheck", "publish"]) {
  test(`cleared-error acknowledgment survives failed ${failure} until successful dispatch`, async (t) => {
    const previous = process.env.BAMBU_REQUIRE_CONFIRMATION;
    process.env.BAMBU_REQUIRE_CONFIRMATION = "1";
    t.after(() => { if (previous === undefined) delete process.env.BAMBU_REQUIRE_CONFIRMATION; else process.env.BAMBU_REQUIRE_CONFIRMATION = previous; });
    const legacyFile = await fixture(t);
    const file = legacyFile.replace(".gcode.3mf", ".3mf");
    await fs.rename(legacyFile, file);
    const { printer } = isolatedPrinter(safetyStatus({ print_error: 123 }));
    await printer.clearHmsErrors(host, serial, token);
    let reads = 0;
    printer.getSafetyStatus = async () => safetyStatus({ state: ++reads === (failure === "confirmation recheck" ? 2 : failure === "dispatch recheck" ? 3 : -1) ? "RUNNING" : "IDLE" });
    const upload = printer.ftpUpload, getPrinter = printer.getPrinter;
    if (failure === "upload") printer.ftpUpload = async () => { throw Error("upload failed"); };
    if (failure === "publish") printer.getPrinter = async () => ({ publish: async () => { throw Error("publish failed"); } });
    const prompts = [];
    printer.confirm = async message => { prompts.push(message); return true; };
    const options = { projectName: "retry", filePath: file, bambuModel: "p1s", useAMS: false };
    await assert.rejects(printer.print3mf(host, serial, token, options));
    assert.equal(prompts.length, 1);
    printer.getSafetyStatus = async () => safetyStatus();
    printer.ftpUpload = upload; printer.getPrinter = getPrinter;
    await printer.print3mf(host, serial, token, options);
    assert.equal(prompts.length, 2, "retry must require a new physical acknowledgment");
    assert.ok(prompts.every(message => message.includes("Previously cleared hardware codes: print_error:123")));
    await printer.print3mf(host, serial, token, options);
    assert.equal(prompts.length, 3);
    assert.ok(!prompts[2].includes("Previously cleared hardware codes"), "a successful checked dispatch consumes the acknowledged codes");
  });
}

test("bridge snapshots are retained only after handoff, including an uncertain result", async (t) => {
  const file = await fixture(t);
  let rejectedSnapshot;
  await assert.rejects(withPrintSnapshot(file, async snapshot => { rejectedSnapshot = snapshot; throw Error("preflight rejected"); }), /preflight rejected/);
  await assert.rejects(fs.access(path.dirname(rejectedSnapshot)), { code: "ENOENT" });
  let dispatchedSnapshot;
  await assert.rejects(withPrintSnapshot(file, async (snapshot, retain) => { dispatchedSnapshot = snapshot; retain(); throw Error("response timed out"); }), /response timed out/);
  assert.deepEqual(await fs.readFile(dispatchedSnapshot), await fs.readFile(file));
  await fs.rm(path.dirname(dispatchedSnapshot), { recursive: true, force: true });
});

test("LAN and signed error clears send the same Studio-form clean_print_error", async () => {
  const status = safetyStatus({ state: "FAILED", print_error: 0x0700_8012, subtask_id: "4567", hms: [] });
  const { printer, events } = isolatedPrinter(status);
  await printer.clearHmsErrors(host, serial, token);
  const lan = events.filter(({ action }) => action === "publish").map(({ payload }) => payload.print);
  assert.equal(lan.length, 1);
  let signed;
  await printer.clearHmsErrors(host, serial, token, async (_active, beforeDispatch, command) => { await beforeDispatch(); signed = command.print; });
  for (const command of [lan[0], signed]) {
    assert.deepEqual(Object.keys(command).sort(), ["command", "print_error", "sequence_id", "subtask_id"]);
    assert.equal(command.command, "clean_print_error");
    assert.equal(command.subtask_id, "4567");
    assert.equal(command.print_error, 0x0700_8012);
    assert.match(command.sequence_id, /^4\d{4}$/);
  }
});
