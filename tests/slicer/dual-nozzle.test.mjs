import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSZip from "jszip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { flattenForCli, detectProfilesRoot } from "../../dist/slicer/profile-flatten.js";
import {
  extrudersFromReport, parseExtruderNozzlesArg, parseFilamentMapArg, parseFilamentSourcesArg, sliceNozzleDiameter,
} from "../../dist/slicer/extruder-config.js";
import { STLManipulator } from "../../dist/stl/stl-manipulator.js";
import { inspectPrintFile } from "../../dist/safety/print-file.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/* --- Fixtures ------------------------------------------------------------ */

/** The user's H2C as it reports itself: right (id 0) Standard hardened steel, left (id 1) High Flow tungsten carbide. */
function h2cReport({ amsInfo = "1023", leftSpool = "PLA" } = {}) {
  return {
    device: { nozzle: { info: [
      { id: 0, diameter: 0.4, type: "HS01", stat: 0 },
      { id: 1, diameter: 0.4, type: "HH05", stat: 0 },
      { id: 16, diameter: 0.2, type: "HS00", stat: 0 },
      { id: 18, diameter: 0.6, type: "HS01", stat: 0 },
    ] } },
    ams: { ams: [{ id: "0", info: amsInfo, tray: [{ id: "0" }, { id: "1" }, { id: "2" }, { id: "3" }] }] },
    vir_slot: [{ id: "254", tray_type: leftSpool }, { id: "255", tray_type: "" }],
  };
}

const DUAL_MACHINE = {
  name: "Bambu Lab TESTDUAL 0.4 nozzle",
  inherits: null,
  instantiation: "true",
  printer_model: "Bambu Lab TESTDUAL",
  nozzle_diameter: ["0.4", "0.4"],
  extruder_type: ["Direct Drive", "Direct Drive"],
  extruder_variant_list: [
    "Direct Drive Standard,Direct Drive High Flow,Direct Drive E3D High Flow",
    "Direct Drive Standard,Direct Drive High Flow",
  ],
  printer_extruder_id: ["1", "1", "1", "2", "2"],
  printer_extruder_variant: ["Direct Drive Standard", "Direct Drive High Flow", "Direct Drive E3D High Flow", "Direct Drive Standard", "Direct Drive High Flow"],
  nozzle_type: Array(5).fill("hardened_steel"),
  physical_extruder_map: ["1", "0"],
  default_nozzle_volume_type: ["Standard", "Standard"],
  unprintable_filament_types: ["TPU", "PPS-CF,PPA-CF"],
};
const VARIANTS = ["Direct Drive Standard", "Direct Drive High Flow", "Direct Drive E3D High Flow"];

async function dualTree(machine = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dual-nozzle-"));
  const bbl = path.join(root, "BBL");
  for (const sub of ["machine", "process", "filament"]) await fs.mkdir(path.join(bbl, sub), { recursive: true });
  await fs.writeFile(path.join(bbl, "cli_config.json"), JSON.stringify({ printer: {
    "Bambu Lab TESTDUAL": { downward_check: { "Bambu Lab TESTDUAL 0.4 nozzle": ["Bambu Lab TESTDUAL 0.4 nozzle"] } },
    "Bambu Lab TESTONE": { downward_check: { "Bambu Lab TESTONE 0.4 nozzle": ["Bambu Lab TESTONE 0.4 nozzle"] } },
  } }));
  const write = (kind, data) => fs.writeFile(path.join(bbl, kind, `${data.name}.json`), JSON.stringify(data));
  await write("machine", { ...DUAL_MACHINE, ...machine });
  await write("machine", {
    name: "Bambu Lab TESTONE 0.4 nozzle", inherits: null, instantiation: "true", printer_model: "Bambu Lab TESTONE",
    nozzle_diameter: ["0.4"], default_nozzle_volume_type: ["Standard"], nozzle_type: ["stainless_steel"],
    extruder_variant_list: ["Direct Drive Standard,Direct Drive High Flow"],
  });
  await write("process", { name: "0.20mm @TEST", inherits: null, layer_height: "0.2" });
  await write("filament", { name: "PLA @TEST", inherits: null, filament_type: ["PLA"], filament_extruder_variant: VARIANTS });
  await write("filament", { name: "TPU @TEST", inherits: null, filament_type: ["TPU"], filament_extruder_variant: VARIANTS });
  await write("filament", { name: "PLA standard-only @TEST", inherits: null, filament_type: ["PLA"], filament_extruder_variant: ["Direct Drive Standard"] });
  const tempDir = path.join(root, "out");
  const flatten = (opts = {}) => flattenForCli({
    machineLeaf: "Bambu Lab TESTDUAL 0.4 nozzle", processLeaf: "0.20mm @TEST",
    filamentLeaves: ["PLA @TEST", "PLA @TEST"], profilesRoot: root, tempDir, ...opts,
  });
  const read = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
  return { root, bbl, flatten, read, tempDir };
}

const H2C_NOZZLES = [{ flow: "High Flow", type: "tungsten_carbide" }, { flow: "Standard", type: "hardened_steel" }];

/* --- Argument parsing ------------------------------------------------------ */

test("nozzles argument: normalizes flows and materials, left first, and rejects typos", () => {
  assert.deepEqual(parseExtruderNozzlesArg([{ flow: "high_flow", type: "Tungsten Carbide", diameter: "0.4" }, { flow: "standard" }]),
    [{ flow: "High Flow", type: "tungsten_carbide", diameter: 0.4 }, { flow: "Standard" }]);
  assert.deepEqual(parseExtruderNozzlesArg('[{"flow":"E3D High Flow"}]'), [{ flow: "E3D High Flow" }]);
  assert.equal(parseExtruderNozzlesArg(undefined), undefined);
  assert.throws(() => parseExtruderNozzlesArg([{ flow: "Turbo" }]), /Unknown nozzle flow "Turbo"/);
  assert.throws(() => parseExtruderNozzlesArg([{ type: "titanium" }]), /Unknown nozzle type/);
  assert.throws(() => parseExtruderNozzlesArg([{ material: "brass" }]), /unknown field\(s\) material/);
  assert.throws(() => parseExtruderNozzlesArg([{ diameter: -1 }]), /positive number/);
  assert.throws(() => parseExtruderNozzlesArg([]), /nonempty array/);
});

test("filament_map and filament_sources arguments", () => {
  assert.deepEqual(parseFilamentMapArg([2, 1]), [2, 1]);
  assert.deepEqual(parseFilamentMapArg("right,left"), [2, 1]);
  assert.deepEqual(parseFilamentMapArg(["left", "2"]), [1, 2]);
  assert.throws(() => parseFilamentMapArg([0]), /extruder number/);
  assert.throws(() => parseFilamentMapArg(["middle"]), /extruder number/);
  assert.deepEqual(parseFilamentSourcesArg("ams;external"), [{ kind: "ams" }, { kind: "external" }]);
  assert.deepEqual(parseFilamentSourcesArg(["ams:128", "ext"]), [{ kind: "ams", unit: 128 }, { kind: "external" }]);
  assert.throws(() => parseFilamentSourcesArg(["shelf"]), /"ams", "ams:<unit id>" or "external"/);
});

/* --- Printer report ------------------------------------------------------- */

test("the H2C report gives each mounted nozzle and which nozzle the AMS and spool holders feed", () => {
  const report = extrudersFromReport(h2cReport());
  assert.deepEqual(report.nozzles, [
    { physical: 0, diameter: 0.4, flow: "Standard", type: "hardened_steel" },
    { physical: 1, diameter: 0.4, flow: "High Flow", type: "tungsten_carbide" },
  ], "rack hotends (16+) are not mounted");
  assert.deepEqual(report.ams, [{ unit: 0, physical: [0] }], "AMS info bits 8-11 = 0: main (right) nozzle");
  assert.deepEqual(report.external, [{ physical: 1, loaded: true }, { physical: 0, loaded: false }]);
});

test("AMS bindings: deputy (left), both via a track switch, unknown without info", () => {
  assert.deepEqual(extrudersFromReport(h2cReport({ amsInfo: "2103" })).ams, [{ unit: 0, physical: [1] }]);
  assert.deepEqual(extrudersFromReport(h2cReport({ amsInfo: "2e03" })).ams, [{ unit: 0, physical: [0, 1] }]);
  assert.deepEqual(extrudersFromReport(h2cReport({ amsInfo: null })).ams, [{ unit: 0, physical: undefined }]);
  const single = extrudersFromReport({ nozzle_diameter: "0.4", nozzle_type: "HS01", ams: { ams: [{ id: "0", info: "1001" }] }, vir_slot: [{ id: "255", tray_type: "" }] });
  assert.deepEqual(single.ams, [{ unit: 0, physical: [0] }]);
  assert.deepEqual(single.external, [{ physical: 0, loaded: false }]);
});

test("one machine-preset diameter: from the nozzles, refused when they differ", () => {
  const report = extrudersFromReport(h2cReport());
  assert.equal(sliceNozzleDiameter(undefined, undefined, report), "0.4");
  assert.equal(sliceNozzleDiameter(undefined, [{ diameter: 0.6 }, { diameter: 0.6 }], report), "0.6", "explicit diameters replace the report");
  assert.equal(sliceNozzleDiameter("0.4", undefined, undefined), "0.4");
  assert.equal(sliceNozzleDiameter(undefined, [{ flow: "Standard" }], undefined), undefined);
  assert.throws(() => sliceNozzleDiameter(undefined, [{ diameter: 0.6 }, {}], report), /no machine preset that mixes nozzle diameters/);
  assert.throws(() => sliceNozzleDiameter("0.6", undefined, report), /does not match the nozzles' 0\.4 mm/);
});

/* --- Profile patches ------------------------------------------------------ */

test("mixed nozzles: per-extruder flow, per-row material and a manual filament map", async () => {
  const t = await dualTree();
  const result = await t.flatten({ extruderNozzles: H2C_NOZZLES, filamentMap: [2, 1] });
  const machine = await t.read(result.machinePath);
  const proc = await t.read(result.processPath);
  assert.deepEqual(machine.nozzle_volume_type, ["High Flow", "Standard"]);
  assert.deepEqual(machine.nozzle_type, ["tungsten_carbide", "tungsten_carbide", "tungsten_carbide", "hardened_steel", "hardened_steel"]);
  assert.equal(proc.filament_map_mode, "Manual");
  assert.deepEqual(proc.filament_map, ["2", "1"]);
  assert.deepEqual(result.meta.extruders, {
    nozzleVolumeType: ["High Flow", "Standard"], nozzleTypes: ["tungsten_carbide", "hardened_steel"], filamentMap: [2, 1],
  });
});

test("the uniform nozzle_type fills extruders that name no material", async () => {
  const t = await dualTree();
  const result = await t.flatten({ extruderNozzles: [{ flow: "High Flow" }, { type: "brass" }], nozzleType: "stainless_steel" });
  const machine = await t.read(result.machinePath);
  assert.deepEqual(machine.nozzle_volume_type, ["High Flow", "Standard"]);
  assert.deepEqual(machine.nozzle_type, ["stainless_steel", "stainless_steel", "stainless_steel", "brass", "brass"]);
});

test("refuses nozzle combinations the profiles don't define", async () => {
  const t = await dualTree();
  await assert.rejects(t.flatten({ extruderNozzles: [{ flow: "Standard" }, { flow: "E3D High Flow" }] }),
    /right nozzle \(extruder 2\).*has no "E3D High Flow" nozzle.*offers: Standard, High Flow/);
  await assert.rejects(t.flatten({ extruderNozzles: [{ diameter: 0.6 }, { diameter: 0.4 }] }),
    /left nozzle \(extruder 1\) has a 0\.6 mm nozzle.*is for 0\.4 mm.*mixes nozzle diameters/);
  await assert.rejects(t.flatten({ extruderNozzles: [{ flow: "Standard" }] }), /has 2 extruder\(s\); nozzles lists 1\. Give \[left, right\]/);
  // A profile lacking per-extruder variants can't vouch for a mix.
  const bare = await dualTree({ extruder_variant_list: undefined });
  await assert.rejects(bare.flatten({ extruderNozzles: H2C_NOZZLES }), /lists no per-extruder nozzle variants/);
});

test("refuses filament maps the machine or filament profiles can't print", async () => {
  const t = await dualTree();
  await assert.rejects(t.flatten({ filamentMap: [1] }), /lists 1 extruder\(s\) for 2 filament slot\(s\)/);
  await assert.rejects(t.flatten({ filamentMap: [3, 1] }), /filament_map\[0\] = 3.*extruders 1 \(left\) and 2 \(right\)/);
  await assert.rejects(t.flatten({ filamentLeaves: ["TPU @TEST", "PLA @TEST"], filamentMap: [1, 2] }),
    /Filament 1 \(TPU\) cannot print on the left nozzle \(extruder 1\)/);
  await assert.rejects(t.flatten({ filamentLeaves: ["PLA standard-only @TEST", "PLA @TEST"], extruderNozzles: H2C_NOZZLES, filamentMap: [1, 2] }),
    /"PLA standard-only @TEST" has no settings for the left nozzle \(extruder 1\)'s Direct Drive High Flow nozzle/);
});

test("printer report: nozzles from the report, map derived from the feeds", async () => {
  const t = await dualTree();
  const reportedExtruders = extrudersFromReport(h2cReport());
  const result = await t.flatten({ reportedExtruders, filamentSources: [{ kind: "ams" }, { kind: "external" }] });
  const machine = await t.read(result.machinePath);
  const proc = await t.read(result.processPath);
  assert.deepEqual(machine.nozzle_volume_type, ["High Flow", "Standard"], "logical left = firmware nozzle 1 via physical_extruder_map");
  assert.deepEqual(machine.nozzle_type.slice(0, 3), Array(3).fill("tungsten_carbide"));
  assert.deepEqual(proc.filament_map, ["2", "1"], "AMS -> right, loaded external holder -> left");
  // Explicit fields win over the report.
  const flowOverride = await t.flatten({ reportedExtruders, extruderNozzles: [{}, { flow: "High Flow" }] });
  assert.deepEqual((await t.read(flowOverride.machinePath)).nozzle_volume_type, ["High Flow", "High Flow"]);
});

test("refuses an AMS filament on a nozzle the AMS doesn't feed", async () => {
  const t = await dualTree();
  const reportedExtruders = extrudersFromReport(h2cReport());
  await assert.rejects(
    t.flatten({ reportedExtruders, filamentSources: [{ kind: "ams" }, { kind: "external" }], filamentMap: [1, 2] }),
    /Filament 1 comes from the AMS, which feeds only the right nozzle \(extruder 2\) on this printer; it cannot print on the left nozzle \(extruder 1\)/);
  await assert.rejects(
    t.flatten({ reportedExtruders, filamentSources: [{ kind: "ams", unit: 1 }, { kind: "external" }] }),
    /AMS unit 1, which is not in the printer report/);
  // Both holders loaded: the external filament could go either way, so the map must be given.
  const both = extrudersFromReport({ ...h2cReport(), vir_slot: [{ id: "254", tray_type: "PLA" }, { id: "255", tray_type: "PETG" }] });
  await assert.rejects(t.flatten({ reportedExtruders: both, filamentSources: [{ kind: "ams" }, { kind: "external" }] }), /give filament_map/);
  const ok = await t.flatten({ reportedExtruders: both, filamentSources: [{ kind: "ams" }, { kind: "external" }], filamentMap: [2, 2] });
  assert.deepEqual((await t.read(ok.processPath)).filament_map, ["2", "2"]);
  await assert.rejects(t.flatten({ filamentSources: [{ kind: "ams" }, { kind: "external" }] }), /needs the printer's report/);
});

test("a stock mixed-flow preset without options is accepted when its variants allow it", async () => {
  const t = await dualTree({ nozzle_volume_type: ["High Flow", "Standard"] });
  const machine = await t.read((await t.flatten()).machinePath);
  assert.deepEqual(machine.nozzle_volume_type, ["High Flow", "Standard"]);
  const bad = await dualTree({ nozzle_volume_type: ["Standard", "E3D High Flow"] });
  await assert.rejects(bad.flatten(), /right nozzle \(extruder 2\).*has no "E3D High Flow" nozzle/);
});

test("single-nozzle printers: unchanged without options, map only to extruder 1", async () => {
  const t = await dualTree();
  const one = (opts) => t.flatten({ machineLeaf: "Bambu Lab TESTONE 0.4 nozzle", filamentLeaves: ["PLA @TEST"], ...opts });
  const plain = await one();
  const machine = await t.read(plain.machinePath);
  const proc = await t.read(plain.processPath);
  assert.deepEqual(machine.nozzle_volume_type, ["Standard"]);
  assert.deepEqual(machine.nozzle_type, ["stainless_steel"]);
  assert.equal(proc.filament_map, undefined);
  assert.equal(plain.meta.extruders, undefined);
  const mapped = await one({ filamentMap: [1], extruderNozzles: [{ flow: "High Flow", type: "hardened_steel" }] });
  assert.equal((await t.read(mapped.processPath)).filament_map, undefined, "a single extruder needs no filament map");
  assert.deepEqual((await t.read(mapped.machinePath)).nozzle_volume_type, ["High Flow"]);
  await assert.rejects(one({ filamentMap: [2] }), /has 1 extruder\(s\)/);
});

/* --- Slicer invocation (fake CLI) ---------------------------------------- */

test("sliceSTL passes per-extruder settings to the CLI files and keeps the uniform nozzle_type path otherwise", async (t) => {
  if (process.platform === "win32") return t.skip("fake CLI is a POSIX shebang script");
  const tree = await dualTree();
  const capture = path.join(tree.root, "args.json");
  const executable = path.join(tree.root, "bambu-studio");
  await fs.writeFile(executable, `#!${process.execPath}\nconst fs = require('fs'); const path = require('path'); const args = process.argv.slice(2); fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(args)); fs.writeFileSync(path.join(args[args.indexOf('--outputdir') + 1], args[args.indexOf('--export-3mf') + 1]), 'fixture output');\n`, { mode: 0o755 });
  const saved = Object.fromEntries(["BAMBU_PROFILES_ROOT", "BAMBU_SLICER_PROFILE_DIRS"].map(k => [k, process.env[k]]));
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  process.env.BAMBU_PROFILES_ROOT = tree.root;
  process.env.BAMBU_SLICER_PROFILE_DIRS = "";
  await fs.writeFile(path.join(tree.bbl, "machine", `${DUAL_MACHINE.name}.json`),
    JSON.stringify({ ...DUAL_MACHINE, default_print_profile: "0.20mm @TEST", default_filament_profile: ["PLA @TEST", "PLA @TEST"] }));
  const stl = path.join(tree.root, "model.stl");
  await fs.writeFile(stl, "fixture STL");
  const manipulator = new STLManipulator(path.join(tree.root, "work"));
  const loaded = async () => {
    const args = JSON.parse(await fs.readFile(capture, "utf8"));
    const [machinePath, processPath] = args[args.indexOf("--load-settings") + 1].split(";");
    return { machine: await tree.read(machinePath), proc: await tree.read(processPath) };
  };

  await manipulator.sliceSTL(stl, "bambustudio", executable, undefined, undefined, DUAL_MACHINE.name,
    { nozzleType: "hardened_steel", extruderNozzles: [{ flow: "High Flow", type: "tungsten_carbide" }, { flow: "Standard" }], filamentMap: [2, 1], bedType: "engineering_plate" });
  let { machine, proc } = await loaded();
  assert.deepEqual(machine.nozzle_volume_type, ["High Flow", "Standard"]);
  assert.deepEqual(machine.nozzle_type, ["tungsten_carbide", "tungsten_carbide", "tungsten_carbide", "hardened_steel", "hardened_steel"],
    "the uniform nozzle_type must not overwrite the per-extruder rows");
  assert.deepEqual(proc.filament_map, ["2", "1"]);
  assert.equal(proc.filament_map_mode, "Manual");
  assert.equal(proc.curr_bed_type, "Engineering Plate");

  await manipulator.sliceSTL(stl, "bambustudio", executable, undefined, undefined, DUAL_MACHINE.name, { nozzleType: "brass" });
  ({ machine, proc } = await loaded());
  assert.deepEqual(machine.nozzle_type, Array(5).fill("brass"));
  assert.deepEqual(machine.nozzle_volume_type, ["Standard", "Standard"]);
  assert.equal(proc.filament_map, undefined);

  await assert.rejects(manipulator.sliceSTL(stl, "bambustudio", executable, undefined, undefined, DUAL_MACHINE.name,
    { extruderNozzles: [{ flow: "Standard" }, { flow: "E3D High Flow" }] }), /has no "E3D High Flow" nozzle/);
});

/* --- MCP tool route (no printer: the report is a recorded fixture) ------ */

test("slice_stl reads the printer's nozzles only when asked and passes them to the slicer", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dual-nozzle-mcp-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const log = path.join(directory, "calls.jsonl");
  const preload = path.join(directory, "boundaries.mjs");
  await fs.writeFile(preload, `
import fs from 'node:fs';
import { STLManipulator } from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, "dist/stl/stl-manipulator.js")).href)};
import { BambuImplementation } from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, "dist/printers/bambu.js")).href)};
const log = (event) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(event) + '\\n');
STLManipulator.prototype.sliceSTL = async function (file, _type, _path, _profile, _progress, preset, options) {
  log({ action: 'slice', preset, options });
  return file;
};
BambuImplementation.prototype.getStatus = async function () { log({ action: 'status' }); throw new Error('no display status in this test'); };
BambuImplementation.prototype.getSafetyStatus = async function () {
  log({ action: 'safety-status' });
  return { connected: true, model: 'h2c', status: 'IDLE', serial: 'TEST_SERIAL', raw: ${JSON.stringify(h2cReport())} };
};
BambuImplementation.prototype.getPrinter = async function () { throw new Error('no printer connections in this test'); };
`);
  const stl = path.join(REPO_ROOT, "test", "sample_cube.stl");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", preload, path.join(REPO_ROOT, "dist/index.js")],
    cwd: directory,
    env: {
      ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "", BAMBU_SERIAL: "TEST_SERIAL", BAMBU_TOKEN: "TEST_TOKEN",
      BAMBU_PRINTER_SERIAL: "TEST_SERIAL", BAMBU_PRINTER_ACCESS_TOKEN: "TEST_TOKEN", BAMBU_PRINTER_HOST: "127.0.0.1",
      PRINTER_HOST: "127.0.0.1", BAMBU_TEMPLATE_3MF: "", BAMBU_SLICER_PROFILE: "", SLICER_TYPE: "bambustudio",
      SLICER_PATH: process.execPath, BAMBU_NOZZLE_TYPE: "", NOZZLE_DIAMETER: "",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "dual-nozzle-tests", version: "1" });
  t.after(() => client.close());
  await client.connect(transport);
  const events = async () => existsSync(log) ? (await fs.readFile(log, "utf8")).trim().split("\n").map(JSON.parse) : [];
  const slice = (extra) => client.callTool({ name: "slice_stl", arguments: { stl_path: stl, bambu_model: "h2c", use_printer_filaments: false, ...extra } });

  const tools = await client.listTools();
  for (const name of ["slice_stl", "slice_with_template"]) {
    const props = tools.tools.find(tool => tool.name === name).inputSchema.properties;
    for (const key of ["nozzles", "nozzles_from_printer", "filament_map", "filament_sources"]) assert.ok(props[key], `${name} exposes ${key}`);
  }

  let result = await slice({ nozzles: H2C_NOZZLES, filament_map: [2, 1], bed_type: "engineering_plate" });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  let [call] = await events();
  assert.equal(call.preset, "Bambu Lab H2C 0.4 nozzle");
  assert.deepEqual(call.options.extruderNozzles, H2C_NOZZLES);
  assert.deepEqual(call.options.filamentMap, [2, 1]);
  assert.equal(call.options.bedType, "engineering_plate");
  assert.equal(call.options.reportedExtruders, undefined, "the printer is not read unless asked");

  await fs.rm(log);
  result = await slice({ nozzles_from_printer: true, filament_sources: ["ams", "external"] });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  const calls = await events();
  assert.deepEqual(calls.map(c => c.action), ["safety-status", "slice"]);
  call = calls[1];
  assert.equal(call.preset, "Bambu Lab H2C 0.4 nozzle", "diameter from the report");
  assert.deepEqual(call.options.reportedExtruders, extrudersFromReport(h2cReport()));
  assert.deepEqual(call.options.filamentSources, [{ kind: "ams" }, { kind: "external" }]);

  await fs.rm(log);
  result = await slice({ nozzles_from_printer: true, nozzle_diameter: "0.6" });
  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text, /nozzle_diameter 0\.6 does not match the nozzles' 0\.4 mm/);
  result = await slice({ nozzles: [{ flow: "Turbo" }] });
  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text, /Unknown nozzle flow "Turbo"/);
  assert.deepEqual((await events()).map(c => c.action), ["safety-status"], "invalid requests never reach the slicer");
});

/* --- Installed Bambu Studio profiles (skipped when absent) ---------------- */

function installedProfilesRoot() {
  const candidates = [
    process.env.BAMBU_PROFILES_ROOT,
    detectProfilesRoot(),
    path.join(os.homedir(), ".local/share/bambu-studio/app/resources/profiles"),
    "/usr/share/bambu-studio/resources/profiles",
  ].filter(Boolean);
  return candidates.find(root => existsSync(path.join(root, "BBL", "machine")));
}

for (const model of ["H2C", "H2D", "H2D Pro", "X2D"]) {
  test(`installed ${model} 0.4 profile takes mixed nozzles from its own variant rows`, async (t) => {
    const profilesRoot = installedProfilesRoot();
    if (!profilesRoot) return t.skip("BambuStudio profiles tree not present on this machine");
    const machineLeaf = `Bambu Lab ${model} 0.4 nozzle`;
    const machineFile = path.join(profilesRoot, "BBL", "machine", `${machineLeaf}.json`);
    if (!existsSync(machineFile)) return t.skip(`Installed BambuStudio profiles do not include ${machineLeaf}`);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dual-installed-"));
    t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
    const processLeaf = JSON.parse(await fs.readFile(machineFile, "utf8")).default_print_profile ?? `0.20mm Standard @BBL ${model}`;
    const base = { machineLeaf, processLeaf, filamentLeaves: [], profilesRoot, tempDir };
    let plain;
    try {
      plain = JSON.parse(await fs.readFile((await flattenForCli(base)).machinePath, "utf8"));
    } catch (error) {
      if (/not found in index/i.test(error?.message || "")) return t.skip(`Installed profiles lack the ${model} process preset`);
      throw error;
    }
    const lists = plain.extruder_variant_list.map(list => list.split(","));
    const flows = lists.map((list, i) => list.map(v => v.slice(plain.extruder_type[i].length + 1)));
    // Left: the second variant (High Flow); right: the first (Standard). The H2C mix.
    const nozzles = [{ flow: flows[0][1], type: "tungsten_carbide" }, { flow: flows[1][0], type: "hardened_steel" }];
    const flat = JSON.parse(await fs.readFile((await flattenForCli({ ...base, extruderNozzles: nozzles })).machinePath, "utf8"));
    assert.deepEqual(flat.nozzle_volume_type, [flows[0][1], flows[1][0]]);
    assert.deepEqual(flat.nozzle_type, flat.printer_extruder_id.map(id => (id === "1" ? "tungsten_carbide" : "hardened_steel")));
    const missing = ["Standard", "High Flow", "TPU High Flow", "E3D High Flow"].find(flow => !flows[1].includes(flow));
    if (missing) {
      await assert.rejects(flattenForCli({ ...base, extruderNozzles: [{}, { flow: missing }] }),
        new RegExp(`right nozzle \\(extruder 2\\) of "${machineLeaf}" has no "${missing}" nozzle`));
    }
  });
}

/* --- Real Bambu Studio CLI (skipped when absent) -------------------------- */

function installedCli() {
  return [
    process.env.SLICER_PATH,
    path.join(os.homedir(), ".local/share/bambu-studio/app/AppRun"),
    "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio",
  ].filter(Boolean).find(file => existsSync(file) && /bambu/i.test(file));
}

/** Two 10 mm cubes as parts of one object, part 1 on filament 1 and part 2 on filament 2. */
async function twoColourProject(file) {
  const cube = (id, x0) => {
    const v = [];
    for (const z of [0, 10]) for (const y of [0, 10]) for (const x of [x0, x0 + 10]) v.push(`<vertex x="${x}" y="${y}" z="${z}"/>`);
    const tri = [[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]]
      .map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
    return `<object id="${id}" type="model"><mesh><vertices>${v.join("")}</vertices><triangles>${tri.join("")}</triangles></mesh></object>`;
  };
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');
  zip.file("3D/3dmodel.model", `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${cube(1, 0)}${cube(2, 15)}<object id="3" type="model"><components><component objectid="1"/><component objectid="2"/></components></object></resources><build><item objectid="3" transform="1 0 0 0 1 0 0 0 1 150 150 0"/></build></model>`);
  zip.file("Metadata/model_settings.config", '<?xml version="1.0" encoding="UTF-8"?><config><object id="3"><metadata key="name" value="two cubes"/><metadata key="extruder" value="1"/><part id="1" subtype="normal_part"><metadata key="name" value="a"/><metadata key="extruder" value="1"/></part><part id="2" subtype="normal_part"><metadata key="name" value="b"/><metadata key="extruder" value="2"/></part></object></config>');
  await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
}

test("real Bambu Studio CLI slices a two-colour H2C job on mixed nozzles", { timeout: 600_000 }, async (t) => {
  const cli = installedCli();
  if (!cli) return t.skip("Bambu Studio CLI not installed");
  const profilesRoot = detectProfilesRoot(cli);
  const filament = path.join(profilesRoot, "BBL", "filament", "Generic PLA @BBL H2C 0.4 nozzle.json");
  if (!existsSync(path.join(profilesRoot, "BBL", "machine", "Bambu Lab H2C 0.4 nozzle.json")) || !existsSync(filament)) {
    return t.skip("Installed Bambu Studio has no H2C profiles");
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dual-nozzle-cli-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const saved = Object.fromEntries(["BAMBU_PROFILES_ROOT", "BAMBU_SLICER_PROFILE_DIRS"].map(k => [k, process.env[k]]));
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  process.env.BAMBU_PROFILES_ROOT = profilesRoot;
  process.env.BAMBU_SLICER_PROFILE_DIRS = "";
  const input = path.join(directory, "two-cubes.3mf");
  await twoColourProject(input);
  const errors = t.mock.method(console, "error", () => {});
  const warnings = t.mock.method(console, "warn", () => {});
  const output = await new STLManipulator(path.join(directory, "out")).sliceSTL(input, "bambustudio", cli, undefined, undefined,
    "Bambu Lab H2C 0.4 nozzle", {
      loadFilaments: `${filament};${filament}`, filamentColours: ["#161616", "#76D9F4"], bedType: "engineering_plate",
      extruderNozzles: H2C_NOZZLES, filamentMap: [2, 1], ensureOnBed: true, arrange: false, minSave: true,
    });
  errors.mock.restore();
  warnings.mock.restore();
  const zip = await JSZip.loadAsync(await fs.readFile(output));
  const settings = JSON.parse(await zip.file("Metadata/project_settings.config").async("string"));
  assert.deepEqual(settings.nozzle_volume_type, ["High Flow", "Standard"]);
  assert.deepEqual(settings.nozzle_type, ["tungsten_carbide", "tungsten_carbide", "tungsten_carbide", "hardened_steel", "hardened_steel"]);
  assert.deepEqual(settings.filament_map, ["2", "1"]);
  assert.equal(settings.filament_map_mode, "Manual");
  assert.equal(settings.curr_bed_type, "Engineering Plate");
  const info = await zip.file("Metadata/slice_info.config").async("string");
  assert.match(info, /key="filament_maps" value="2 1"/);
  assert.match(info, /<nozzle id="0" extruder_id="1" nozzle_diameter="0.4" volume_type="High Flow"\/>/);
  assert.match(info, /<nozzle id="1" extruder_id="2" nozzle_diameter="0.4" volume_type="Standard"\/>/);
  const gcode = await zip.file("Metadata/plate_1.gcode").async("string");
  assert.match(gcode, /^T0\b/m, "filament 1 prints");
  assert.match(gcode, /^T1\b/m, "filament 2 prints");
  // The print gate reads the same per-extruder setup back from the file.
  const inspection = await inspectPrintFile(output, { model: "h2c", nozzleDiameters: [0.4, 0.4], bedType: "engineering_plate" });
  assert.deepEqual(inspection.nozzleFlows, ["high_flow", "standard"]);
  assert.deepEqual(inspection.nozzleTypes, ["tungsten_carbide", "hardened_steel"]);
  assert.deepEqual(inspection.filamentMap, [2, 1]);
  assert.deepEqual(inspection.usedFilamentPositions, [0, 1]);
});

/* --- Hotend racks and Hybrid (H2C right extruder) -------------------------- */

const RACK = { extruder_max_nozzle_count: ["1", "6"] };

test("nozzles argument: Hybrid flow and per-flow hotend counts", () => {
  assert.deepEqual(parseExtruderNozzlesArg([{ flow: "high flow" }, { flow: "hybrid", hotends: { standard: 3, "High Flow": "3" } }]),
    [{ flow: "High Flow" }, { flow: "Hybrid", hotends: { Standard: 3, "High Flow": 3 } }]);
  assert.throws(() => parseExtruderNozzlesArg([{}, { hotends: { Hybrid: 2 } }]), /Unknown nozzle flow "Hybrid"/);
  assert.throws(() => parseExtruderNozzlesArg([{}, { hotends: { Standard: 1.5 } }]), /whole number/);
  assert.throws(() => parseExtruderNozzlesArg([{}, { hotends: { Standard: 0 } }]), /lists no hotend/);
});

test("the report lists every normal hotend with a known flow, rack ones on the main extruder", () => {
  const report = h2cReport();
  report.device.nozzle.info.push({ id: 19, diameter: 0.4, type: "HH01", stat: 0 }, { id: 20, diameter: 0.4, type: "HH01", stat: 2 });
  assert.deepEqual(extrudersFromReport(report).hotends, [
    { physical: 0, diameter: 0.4, flow: "Standard" }, { physical: 1, diameter: 0.4, flow: "High Flow" },
    { physical: 0, diameter: 0.2, flow: "Standard" }, { physical: 0, diameter: 0.6, flow: "Standard" }, { physical: 0, diameter: 0.4, flow: "High Flow" },
  ], "the abnormal hotend 20 is left out");
});

test("a Hybrid rack extruder slices with its hotends' flows through the CLI's nozzle options", async () => {
  const t = await dualTree(RACK);
  const hybrid = await t.flatten({ extruderNozzles: [{ flow: "High Flow" }, { flow: "Hybrid", hotends: { "High Flow": 3, Standard: 3 } }] });
  assert.deepEqual((await t.read(hybrid.machinePath)).nozzle_volume_type, ["High Flow", "Hybrid"]);
  assert.deepEqual(hybrid.meta.extruders.hotends, [{ "High Flow": 1 }, { "High Flow": 3, Standard: 3 }]);
  // Studio's own CLI form: Standard sub-nozzles before High Flow ones (NozzleVolumeType order).
  assert.deepEqual(hybrid.meta.extruders.cliArgs, ["--nozzle-volume-type", "High Flow,Hybrid", "--extruder-nozzle-count", "1,6",
    "--extruder-nozzle-volume-type", "High Flow,Standard,Standard,Standard,High Flow,High Flow,High Flow"]);
  // Hotends of two flows without a flow make the extruder Hybrid; of one flow, that flow.
  const implied = await t.flatten({ extruderNozzles: [{}, { hotends: { Standard: 2, "High Flow": 1 } }] });
  assert.deepEqual(implied.meta.extruders.nozzleVolumeType, ["Standard", "Hybrid"]);
  const single = await t.flatten({ extruderNozzles: [{}, { hotends: { "High Flow": 2 } }] });
  assert.deepEqual(single.meta.extruders.nozzleVolumeType, ["Standard", "High Flow"]);
  assert.deepEqual(single.meta.extruders.cliArgs, ["--extruder-nozzle-count", "1,2", "--extruder-nozzle-volume-type", "Standard,High Flow,High Flow"]);
  // A filament needs settings for at least one of the Hybrid extruder's flows.
  await t.flatten({ filamentLeaves: ["PLA standard-only @TEST", "PLA @TEST"], filamentMap: [2, 2],
    extruderNozzles: [{}, { flow: "Hybrid", hotends: { Standard: 1, "High Flow": 1 } }] });
  await assert.rejects(t.flatten({ filamentLeaves: ["PLA standard-only @TEST", "PLA @TEST"], filamentMap: [2, 2],
    extruderNozzles: [{}, { flow: "Hybrid", hotends: { "High Flow": 2 } }] }), /no "Standard" hotend|High Flow nozzle/);
});

test("Hybrid is refused without a rack, without hotends to mix, or with a flow the extruder lacks", async () => {
  const t = await dualTree(RACK);
  await assert.rejects(t.flatten({ extruderNozzles: [{}, { flow: "Hybrid" }] }), /Hybrid without hotends of two or more flows/);
  await assert.rejects(t.flatten({ extruderNozzles: [{ flow: "Hybrid", hotends: { Standard: 1 } }, {}] }), /holds one hotend/);
  await assert.rejects(t.flatten({ extruderNozzles: [{}, { flow: "Hybrid", hotends: { Standard: 3, "E3D High Flow": 3 } }] }), /right nozzle \(extruder 2\).*has no "E3D High Flow" nozzle/);
  await assert.rejects(t.flatten({ extruderNozzles: [{}, { flow: "Hybrid", hotends: { Standard: 4, "High Flow": 3 } }] }), /holds at most 6/);
  await assert.rejects(t.flatten({ extruderNozzles: [{}, { flow: "Standard", hotends: { "High Flow": 2 } }] }), /no "Standard" hotend/);
  const noRack = await dualTree();
  await assert.rejects(noRack.flatten({ extruderNozzles: [{}, { flow: "Hybrid", hotends: { Standard: 1, "High Flow": 1 } }] }), /holds one hotend/);
});

test("a rack holding several flows at the slice diameter makes nozzles_from_printer slice the right extruder Hybrid", async () => {
  const t = await dualTree(RACK);
  const report = h2cReport();
  report.device.nozzle.info.push({ id: 19, diameter: 0.4, type: "HH01", stat: 0 }, { id: 21, diameter: 0.4, type: "HH01", stat: 0 });
  const result = await t.flatten({ reportedExtruders: extrudersFromReport(report), filamentMap: [2, 2] });
  assert.deepEqual(result.meta.extruders.nozzleVolumeType, ["High Flow", "Hybrid"]);
  assert.deepEqual(result.meta.extruders.hotends, [{ "High Flow": 1 }, { Standard: 1, "High Flow": 2 }], "the 0.2 and 0.6 hotends don't count");
  // An explicit flow keeps that flow's hotends only.
  const standard = await t.flatten({ reportedExtruders: extrudersFromReport(report), extruderNozzles: [{}, { flow: "Standard" }] });
  assert.deepEqual(standard.meta.extruders.nozzleVolumeType, ["High Flow", "Standard"]);
  await assert.rejects(t.flatten({ reportedExtruders: extrudersFromReport(h2cReport()), extruderNozzles: [{}, { flow: "High Flow" }] }), /reports no 0.4 mm High Flow hotend for the right nozzle/);
});

test("sliceSTL passes a Hybrid setup's nozzle options to the CLI", async (t) => {
  if (process.platform === "win32") return t.skip("fake CLI is a POSIX shebang script");
  const tree = await dualTree(RACK);
  const capture = path.join(tree.root, "args.json");
  const executable = path.join(tree.root, "bambu-studio");
  await fs.writeFile(executable, `#!${process.execPath}\nconst fs = require('fs'); const path = require('path'); const args = process.argv.slice(2); fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(args)); fs.writeFileSync(path.join(args[args.indexOf('--outputdir') + 1], args[args.indexOf('--export-3mf') + 1]), 'fixture output');\n`, { mode: 0o755 });
  const saved = Object.fromEntries(["BAMBU_PROFILES_ROOT", "BAMBU_SLICER_PROFILE_DIRS"].map(k => [k, process.env[k]]));
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  process.env.BAMBU_PROFILES_ROOT = tree.root;
  process.env.BAMBU_SLICER_PROFILE_DIRS = "";
  await fs.writeFile(path.join(tree.bbl, "machine", `${DUAL_MACHINE.name}.json`),
    JSON.stringify({ ...DUAL_MACHINE, ...RACK, default_print_profile: "0.20mm @TEST", default_filament_profile: ["PLA @TEST", "PLA @TEST"] }));
  const stl = path.join(tree.root, "model.stl");
  await fs.writeFile(stl, "fixture STL");
  await new STLManipulator(path.join(tree.root, "work")).sliceSTL(stl, "bambustudio", executable, undefined, undefined, DUAL_MACHINE.name,
    { extruderNozzles: [{ flow: "High Flow" }, { flow: "Hybrid", hotends: { Standard: 2, "High Flow": 2 } }] });
  const args = JSON.parse(await fs.readFile(capture, "utf8"));
  const option = name => args[args.indexOf(name) + 1];
  assert.equal(option("--nozzle-volume-type"), "High Flow,Hybrid");
  assert.equal(option("--extruder-nozzle-count"), "1,4");
  assert.equal(option("--extruder-nozzle-volume-type"), "High Flow,Standard,Standard,High Flow,High Flow");
  assert.equal(args.at(-1), stl, "the input stays last");
});
