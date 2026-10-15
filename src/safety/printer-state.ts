import { BambuClient, GetVersionCommand, PushAllCommand } from "bambu-node";
import { normalizeMaterial, normalizeModel } from "./limits.js";
import { filamentProhibition } from "./filament-rules.js";
import { DEPUTY_EXTRUDER_ID, DUAL_EXTRUDER_MODELS, MAIN_EXTRUDER_ID, NOZZLE_RACK_MODELS, printerTypeModel, externalHolders, extruderCount, isExternalTray, physicalExtruderMap } from "./models.js";

const MAX_REPORT_AGE_MS = 15_000;
const SERIAL_MODELS: Record<string, string> = {
  "093": "H2S", "094": "H2D", "31B": "H2C", "239": "H2D Pro", "20P": "X2D",
  "00M": "X1C", "00W": "X1", "03W": "X1E", "01S": "P1P", "01P": "P1S", "22E": "P2S", "039": "A1", "030": "A1 Mini",
};

/** The model a serial prefix belongs to (Studio's sn_prefix). Identity evidence only together with a fresh report. */
export function serialModel(serial: string): string | undefined {
  return normalizeModel(SERIAL_MODELS[serial.trim().toUpperCase().slice(0, 3)] ?? "");
}

function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function observedIdentity(raw: Record<string, any>, configuredSerial: string) {
  // Current firmware reports a cloud model id (e.g. US2856e2270b4bb2) in model_id, which names no printer; only a
  // Studio printer_type code or a model name there is identity evidence.
  const recognizedModelFromModelId = typeof raw.model_id === "string" && raw.model_id.trim()
    ? normalizeModel(printerTypeModel(raw.model_id) ?? raw.model_id)
    : undefined;
  const declarations = [raw.model, raw.printer_type, raw.device?.devModel, raw.device?.dev_model]
    .filter(value => typeof value === "string" && value.trim());
  const models = declarations.map(value => normalizeModel(printerTypeModel(value) ?? value));
  if (models.some(model => !model)) throw new Error("Printer reported an unknown model identity; cannot verify this printer.");
  if (recognizedModelFromModelId) models.unshift(recognizedModelFromModelId);
  const hasReportedModel = models.length > 0;
  const serials = [raw.serial, raw.serial_number, raw.sn, raw.device?.sn,
    ...(Array.isArray(raw.modules) ? raw.modules.filter((module: any) => module?.name === "ota").map((module: any) => module.sn) : [])]
    .filter(value => typeof value === "string" && value.trim()).map(value => value.trim());
  if (serials.some(serial => serial.toUpperCase() !== configuredSerial.trim().toUpperCase())) {
    throw new Error("Printer-returned serial does not match the configured printer serial.");
  }
  for (const serial of serials) {
    const model = normalizeModel(SERIAL_MODELS[serial.toUpperCase().slice(0, 3)] ?? "");
    if (model) models.push(model);
  }
  if (new Set(models).size > 1) throw new Error("Printer returned contradictory model identity information.");
  const model = models[0];
  return { model, observedSerial: serials[0], identitySource: hasReportedModel ? "report" : "module-serial" };
}

/** Only raw reports received after this request are evidence. Never read printer.data here. */
export function readFreshPrinterStatus(printer: BambuClient, serial: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw: Record<string, any> = {};
    const requestedAt = Date.now();
    let receivedAt = 0;
    let requestsPublished = false;
    let complete = false;
    const cleanup = () => {
      clearTimeout(timer);
      printer.off("rawMessage", onRaw);
      printer.off("client:disconnect", onDisconnect);
      printer.off("client:error", onError);
    };
    const fail = (error: unknown) => {
      if (complete) return;
      complete = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const maybeResolve = () => {
      if (complete || !requestsPublished || !receivedAt || !Object.prototype.hasOwnProperty.call(raw, "gcode_state") ||
          !Object.prototype.hasOwnProperty.call(raw, "print_error") || !Object.prototype.hasOwnProperty.call(raw, "hms")) return;
      try {
        const identity = observedIdentity(raw, serial);
        if (!identity.model) return;
        complete = true;
        cleanup();
        resolve({ connected: true, model: identity.model, status: raw.gcode_state, serial,
          observedSerial: identity.observedSerial, raw,
          observation: { source: "mqtt", requestedAt, receivedAt, identitySource: identity.identitySource } });
      } catch (error) { fail(error); }
    };
    const onRaw = (topic: string, payload: Buffer) => {
      if (complete || topic !== `device/${serial}/report`) return;
      let parsed: any;
      try { parsed = JSON.parse(payload.toString()); } catch { return; }
      if (object(parsed.print) && parsed.print.command === "push_status") {
        raw = { ...raw, ...parsed.print };
        receivedAt = Date.now();
      }
      if (object(parsed.info) && parsed.info.command === "get_version" && Array.isArray(parsed.info.module)) {
        raw = { ...raw, modules: parsed.info.module };
      }
      maybeResolve();
    };
    const onDisconnect = () => fail(new Error("Printer disconnected while waiting for a fresh safety report."));
    const onError = (error: Error) => fail(error);
    const timer = setTimeout(() => fail(new Error("Timed out waiting for a fresh MQTT safety report with observed printer identity, state and errors; cached status cannot authorize an operation.")), timeoutMs);
    printer.on("rawMessage", onRaw);
    printer.on("client:disconnect", onDisconnect);
    printer.on("client:error", onError);
    // invoke() publishes only; executeCommand() would add an ACK dependency that H2 firmware lacks.
    void Promise.all([new PushAllCommand().invoke(printer), new GetVersionCommand().invoke(printer)])
      .then(() => { requestsPublished = true; maybeResolve(); }, fail);
  });
}

export interface PrinterStateRequirements {
  model: string;
  nozzleDiameters: number[];
  materials?: string[];
  usedFilamentPositions?: number[];
  amsMapping?: number[];
  useAMS?: boolean;
  requireIdle?: boolean;
  /** File transfer only (nothing starts): any known state is accepted, including FAILED after a cancel. */
  uploadOnly?: boolean;
  /** Raw gcode_file transport cannot load a mapped spool before printing. */
  requireLoadedFilament?: boolean;
  /** Upload-only identity checks do not select or consume a physical filament slot. */
  verifyMaterials?: boolean;
  /** Zero-based firmware nozzle indices corresponding positionally to nozzleDiameters. */
  usedNozzleIndices?: number[];
  nozzleTypes?: string[];
  nozzleFlows?: string[];
  /** Sliced (logical, left first) extruder to physical extruder id; Studio's default for dual-nozzle printers is [1,0]. */
  physicalExtruderMap?: number[];
  /** Per filament: sliced extruder (1 = left, 2 = right), raw filament_type (e.g. PLA-CF) and Bambu filament id. */
  filamentMap?: number[];
  filamentTypes?: string[];
  filamentIds?: string[];
  /** Per filament: the preset name (filament_settings_id without its " @..." machine suffix). */
  filamentNames?: string[];
}
export interface ReportedNozzle { index: number; diameter: number; type?: string; flow?: string; stat?: number }
interface ReportedFilament { position: number; material: string; trayIndex: number; nozzleMin?: number; nozzleMax?: number }
export interface ValidatedPrinterState { model: string; reportedNozzles: ReportedNozzle[]; filaments: ReportedFilament[]; hmsWarnings: string[] }

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
const token = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase().replace(/[\s_-]/g, "") : "";
const NOZZLE_TYPES = ["stainlesssteel","hardenedsteel","tungstencarbide","brass"];
const NOZZLE_FLOWS = ["standard","highflow","tpuhighflow","e3dhighflow"];
// BambuStudio resources/info/nozzle_info.json nozzle_hrc (Print::get_hrc_by_nozzle_type defaults).
const NOZZLE_HRC: Record<string, number> = { hardenedsteel: 55, stainlesssteel: 20, tungstencarbide: 85, brass: 2 };
/** Bambu filament profiles' required_nozzle_HRC: 40 for carbon/glass-filled, PA/PPA/PPS and PLA Glow, 3 otherwise. */
function requiredNozzleHrc(type: unknown, filamentId?: string): number {
  const id = String(filamentId ?? "").trim().toUpperCase();
  if (id === "GFA12") return 40;
  if (id === "GFN99" || /^GFS/.test(id)) return 3;
  const text = String(type ?? "").trim().toUpperCase();
  return /-(?:CF|GF)\b|^(?:PA(?:6|12|HT)?|PPA|PPS)(?:$|[-\s])/.test(text) ? 40 : 3;
}
function nozzleTypeAndFlow(value: unknown): {type?: string; flow?: string} {
  const text = String(value ?? "");
  if (/^H[A-Z]\d\d/i.test(text)) {
    // BambuStudio DeviceCore/DevNozzleSystem.cpp s_parse_nozzle_type.
    const types: Record<string,string> = {"00":"stainlesssteel","01":"hardenedsteel","05":"tungstencarbide"};
    const flows: Record<string,string> = {S:"standard",A:"standard",X:"standard",H:"highflow",E:"highflow",U:"tpuhighflow",B:"e3dhighflow"};
    return {type:types[text.slice(2,4)],flow:flows[text[1].toUpperCase()]};
  }
  const type = token(value);
  return {type: ["stainlesssteel","hardenedsteel","tungstencarbide","brass"].includes(type) ? type : undefined};
}
/** Mounted nozzles (ids 0-15) by firmware id; with rack, the H2C hotend-rack nozzles (ids 16-31) instead. */
export function reportedNozzles(raw: Record<string,any>, rack = false): ReportedNozzle[] {
  const info = raw.device?.nozzle?.info;
  const output: ReportedNozzle[] = [];
  if (Array.isArray(info)) {
    for (const entry of info) {
      const index = finiteNumber(entry?.id);
      // Rack nozzles (0x10+) are stored hotends, not the one mounted on an extruder.
      if (index !== undefined && (index >= 16) !== rack) continue;
      const diameter = finiteNumber(entry?.diameter);
      if (index === undefined || !Number.isInteger(index) || index < 0 || index > 31 || diameter === undefined || diameter <= 0) throw new Error("Printer reported malformed nozzle identity or diameter.");
      let stat: number | undefined;
      if (entry.stat !== undefined) {
        stat = finiteNumber(entry.stat);
        if (stat === undefined || !Number.isInteger(stat) || stat < 0) throw new Error(`Printer nozzle ${index} status is malformed.`);
      }
      if (output.some(nozzle => nozzle.index === index)) throw new Error("Printer reported ambiguous duplicate nozzle indices.");
      output.push({index,diameter,...nozzleTypeAndFlow(entry.type),...(stat === undefined ? {} : {stat})});
    }
    if (rack) return output;
  } else if (rack) {
    return output;
  } else if (Array.isArray(raw.nozzle_diameter)) {
    raw.nozzle_diameter.forEach((value: unknown,index: number) => {
      const diameter = finiteNumber(value);
      if (diameter === undefined || diameter <= 0) throw new Error("Printer reported an unknown nozzle diameter.");
      output.push({index,diameter,...nozzleTypeAndFlow(Array.isArray(raw.nozzle_type) ? raw.nozzle_type[index] : raw.nozzle_type),
        ...(Array.isArray(raw.nozzle_volume_type) ? {flow:token(raw.nozzle_volume_type[index])} : {})});
    });
  } else {
    const diameter = finiteNumber(raw.nozzle_diameter);
    if (diameter !== undefined && diameter > 0) {
      const configuration = nozzleTypeAndFlow(raw.nozzle_type);
      // Manufacturer legacy ParseV1_0 defaults a recognized nozzle to standard flow;
      // flag3 bits 10..12 equal 1 report the legacy high-flow upgrade.
      // https://github.com/bambulab/BambuStudio/blob/master/src/slic3r/GUI/DeviceCore/DevNozzleSystem.cpp
      if (configuration.type && !configuration.flow) {
        configuration.flow = "standard";
        if (raw.flag3 !== undefined) {
          const flag = finiteNumber(raw.flag3);
          if (flag === undefined || !Number.isInteger(flag) || flag < 0 || flag > 0xffffffff) throw new Error("Printer legacy nozzle flow report is malformed.");
          // DevNozzleSystem ParseV1_0: 1 is the high-flow upgrade, every other value standard flow.
          if (((flag >>> 10) & 7) === 1) configuration.flow = "highflow";
        }
      }
      output.push({index:0,diameter,...configuration,
        ...(raw.nozzle_volume_type !== undefined ? {flow:token(raw.nozzle_volume_type)} : {})});
    }
  }
  return output;
}

// Periodic maintenance reminders (BambuStudio resources/hms, e.g. hms_en_31B.json): 0501-0400-0003-<n>.
// 0002 threaded rods need lubrication; 0003 linear rods need cleaning and lubrication; 0004 clean and lubricate
// the X rail, YZ rods (and H2C extruder lift rail); 0005 H2C induction hotend latch and hotend change rods;
// 0006 H2C induction hotend latch may be worn; 0007 clean or replace the air filter; 0010 laser module is dusty.
// They report service intervals, not a printer fault, so they never block. Other codes stay fail-closed.
const MAINTENANCE_REMINDER_ATTR = 0x05010400;
const MAINTENANCE_REMINDER_CODES = new Set([0x00030002, 0x00030003, 0x00030004, 0x00030005, 0x00030006, 0x00030007, 0x00030010]);
const isMaintenanceReminder = (attr: number, code: number) => attr === MAINTENANCE_REMINDER_ATTR && MAINTENANCE_REMINDER_CODES.has(code);

// HMS severities (BambuStudio DevHMS.cpp: code >> 16; DevHMS.h): 1 fatal, 2 serious, 3 common, 4 info.
// Only fatal entries block, like a print error: the printer itself refuses to start a job it can't run, and Bambu
// Studio starts prints with serious/common entries listed. Those come back as warnings so the caller sees them.
// Malformed entries and unknown severities still fail closed.
// print_error class: the fifth hex digit of the code, code & 0xF000 (Bambu's HMS database). 4xxx records a task that
// stopped (0300-400C "The task was canceled.", 0500-400E "Job was cancelled.", 0502-4010 "Printer incompatible with sliced
// file"); 8xxx pauses for an action and Cxxx prompts. Bambu Studio never gates a new job on print_error; a stop-class
// code stays until the next job starts, so in an idle state it is a warning. Pause and prompt classes still block.
const PRINT_ERROR_STOP_CLASS = 0x4000;
const hexCode = (value: number) => value.toString(16).toUpperCase().padStart(8, "0").replace(/^(.{4})/, "$1-");
// Fatal HMS entries that are not hardware faults: 0500-0500-0001-0007 "MQTT command verification failed" is the
// printer refusing an unsigned command (firmware 01.08.05+ outside LAN Only + Developer Mode), not a reason the
// printer can't print. Every other fatal entry still blocks.
const NON_FAULT_FATAL_HMS = new Set(["0500-0500-0001-0007"]);

function validateErrors(raw: Record<string,any>, requireIdle: boolean, uploadOnly = false): string[] {
  const state = typeof raw.gcode_state === "string" ? raw.gcode_state.toUpperCase() : "UNKNOWN";
  // FAILED is how Bambu firmware reports a stopped or failed job; the printer is idle and takes a new job (as from
  // Bambu Studio). Like FINISH it may leave a part on the bed, so it goes through the same bed-clearance check.
  if (uploadOnly) {
    // Studio has no state gate for a file transfer; a cancel leaves the printer in FAILED.
    if (!["IDLE","FINISH","FAILED","RUNNING","PAUSE","PREPARE","SLICING"].includes(state)) throw new Error(`Printer state ${state} is unknown.`);
  } else if (requireIdle && !["IDLE","FINISH","FAILED"].includes(state)) throw new Error(`Printer state ${state} is not safely idle.`);
  else if (!requireIdle && !["IDLE","FINISH","RUNNING","PAUSE"].includes(state)) throw new Error(`Printer state ${state} is unknown or failed.`);
  const warnings: string[] = [];
  const printError = finiteNumber(raw.print_error);
  if (printError !== undefined && Number.isInteger(printError) && printError > 0 && printError <= 0xffffffff &&
      (requireIdle || uploadOnly) && (printError & 0xf000) === PRINT_ERROR_STOP_CLASS) {
    warnings.push(`print_error ${hexCode(printError)} (${printError === 0x0300400c ? "the previous task was canceled" : "the previous task stopped"})`);
  } else if (printError !== 0) throw new Error(`Printer reports a print error${printError !== undefined ? ` (${hexCode(printError)})` : " or did not report its error state"}.`);
  if (!Array.isArray(raw.hms)) throw new Error("Printer HMS error state is missing or malformed.");
  for (const entry of raw.hms) {
    const code = finiteNumber(entry?.code);
    const attr = finiteNumber(entry?.attr);
    const wellFormed = code !== undefined && attr !== undefined && Number.isInteger(code) && Number.isInteger(attr) &&
      code >= 0 && code <= 0xffffffff && attr >= 0 && attr <= 0xffffffff;
    const hex = (value: number) => value.toString(16).toUpperCase().padStart(8, "0");
    const label = wellFormed ? `HMS ${hex(attr!).slice(0, 4)}-${hex(attr!).slice(4)}-${hex(code!).slice(0, 4)}-${hex(code!).slice(4)}` : "";
    if (wellFormed && isMaintenanceReminder(attr!, code!)) { warnings.push(`${label} (maintenance reminder)`); continue; }
    if (wellFormed && NON_FAULT_FATAL_HMS.has(label.slice(4))) { warnings.push(`${label} (a refused unsigned command, not a printer fault)`); continue; }
    const severity = wellFormed ? Math.floor(code! / 65536) : 0;
    if (severity === 2 || severity === 3) { warnings.push(`${label} (${severity === 2 ? "serious" : "common"})`); continue; }
    if (severity === 4) continue;
    throw new Error(`Printer reports ${severity === 1 ? "a fatal" : "an unknown or malformed"} HMS error${label ? ` (${label})` : ""}; inspect and resolve it before proceeding.`);
  }
  return warnings;
}
function trayRange(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "" || value === "0" || value === 0) return undefined;
  const number = finiteNumber(value);
  if (number === undefined || number <= 0) throw new Error(`Reported filament ${label} temperature is malformed.`);
  return number;
}
function externalTray(raw: Record<string,any>, model: string, trayIndex: number): Record<string,any> | undefined {
  const holders = externalHolders(model);
  const dual = DUAL_EXTRUDER_MODELS.has(model);
  // Single-extruder printers have one holder; 254 is the MCP's historical name for it, 255 Studio's.
  if (!dual ? !isExternalTray(trayIndex) : !holders.includes(trayIndex)) {
    throw new Error(dual && isExternalTray(trayIndex)
      ? `The ${model.toUpperCase()} has no usable external spool holder ${trayIndex}; ${holders.join(" and ")} feed its nozzles.`
      : `External spool ${trayIndex} is not a holder on this printer.`);
  }
  const slots = raw.vir_slot;
  if (Array.isArray(slots) && slots.length > 0) {
    // BambuStudio DeviceManager.cpp: vir_slot id 255 is the main (right or only) holder, 254 the deputy (left).
    if (slots.some((slot:any) => !isExternalTray(Number(slot?.id))) || new Set(slots.map((slot:any) => Number(slot.id))).size !== slots.length) {
      throw new Error("External spool report is ambiguous for this nozzle; cannot verify the selected material.");
    }
    if (!dual) {
      if (slots.length !== 1) throw new Error("External spool report is ambiguous for this nozzle; cannot verify the selected material.");
      return slots[0];
    }
    const selected = slots.find((slot:any) => Number(slot.id) === trayIndex);
    if (!selected) throw new Error(`External spool holder ${trayIndex} is not present in the fresh printer report.`);
    return selected;
  }
  if (!object(raw.vt_tray)) return undefined;
  // A legacy vt_tray names one holder; on a dual-nozzle printer it says nothing about the other one.
  return !dual || raw.vt_tray.id === undefined || Number(raw.vt_tray.id) === trayIndex ? raw.vt_tray : undefined;
}
function mappedTray(raw: Record<string,any>, index: number): Record<string,any> {
  // BambuStudio DevFilaSystem::GetTrayIndexMap: AMS units 0-3 hold four trays each (index unit * 4 + slot); an AMS-HT
  // unit (ids 128-135) holds one, so its index is its unit id with slot 0.
  if (!Number.isInteger(index) || index < 0 || (index > 15 && index < 128) || index > 135) throw new Error(`AMS mapped slot ${index} is not an AMS tray.`);
  const unit = index >= 128 ? index : Math.floor(index / 4);
  const slot = index >= 128 ? 0 : index % 4;
  const units = raw.ams?.ams;
  const ams = Array.isArray(units) ? units.find((value:any) => Number(value?.id) === unit) : undefined;
  const tray = Array.isArray(ams?.tray) ? ams.tray.find((value:any) => Number(value?.id) === slot) : undefined;
  if (!object(tray)) throw new Error(`AMS mapped slot ${index} is not present in the fresh printer report.`);
  // Presence is the top-level ams.tray_exist_bits: bit unit * 4 + slot for AMS units, bit 16 + (unit - 128) for AMS-HT
  // (DevAms::GetTrayId / sGetAmsFlagBit). AMS-HT units carry no bits of their own.
  const bits = raw.ams?.tray_exist_bits;
  if (bits !== undefined) {
    let present: boolean;
    try { present = (BigInt(typeof bits === "string" ? `0x${bits.replace(/^0x/i, "")}` : bits) & (1n << BigInt(index >= 128 ? 16 + index - 128 : index))) !== 0n; }
    catch { throw new Error("AMS slot presence report is malformed."); }
    if (!present) throw new Error(`AMS mapped slot ${index} is reported empty.`);
  }
  return tray;
}

/**
 * On dual-nozzle printers each AMS is bound to one extruder (BambuStudio DevFilaSystemParser::ParseAmsInfo: `info` hex
 * bits 8-11: 0 main/right, 1 deputy/left, 0xE a Filament Track Switch) and each external holder
 * feeds one (254 left, 255 right). Studio only offers trays that can reach the filament's extruder; a job mapped
 * otherwise pauses with 1807-8006 ("The AMS may be mismatched with the extruder"), so it's refused here.
 */
function assertFeedsExtruder(raw: Record<string,any>, model: string, trayIndex: number, extruder: number, position: number): void {
  const side = (id: number) => id === MAIN_EXTRUDER_ID ? "right" : "left";
  let feeds: number[];
  let source: string;
  if (isExternalTray(trayIndex)) {
    feeds = [trayIndex === 254 ? DEPUTY_EXTRUDER_ID : MAIN_EXTRUDER_ID];
    source = `External spool ${trayIndex}`;
  } else {
    const unitId = trayIndex >= 128 ? trayIndex : Math.floor(trayIndex / 4);
    const unit = (raw.ams?.ams as any[]).find((value:any) => Number(value?.id) === unitId);
    source = `AMS ${trayIndex >= 128 ? `HT ${unitId}` : unitId}`;
    // Dual-nozzle firmware reports info for every unit; without it the binding can't be established (Studio would
    // assume the main extruder), so only the tray's own checks apply.
    if (unit?.info === undefined) return;
    {
      let info: bigint;
      try { info = BigInt(`0x${String(unit.info).replace(/^0x/i, "")}`); } catch { throw new Error(`${source} reports a malformed info field.`); }
      const bound = Number((info >> 8n) & 0xfn);
      // A Filament Track Switch can route to both extruders, but only while one is reported fitted.
      if (bound === 0xe) feeds = raw.device?.fila_switch && typeof raw.device.fila_switch === "object" ? [MAIN_EXTRUDER_ID, DEPUTY_EXTRUDER_ID] : [];
      else feeds = [bound];
    }
  }
  if (!feeds.includes(extruder)) {
    throw new Error(`${source} can't feed the ${model.toUpperCase()}'s ${side(extruder)} nozzle, which filament ${position + 1} is sliced for` +
      ` (it feeds ${feeds.length ? feeds.map(side).join(" and ") : "no nozzle"}). Map it to a tray on that side or re-slice; the printer would stop with 1807-8006.`);
  }
}

/** Verifies reported configuration, not a physical nozzle/spool inspection. */
export function validatePrinterState(status: any, requirements: PrinterStateRequirements): ValidatedPrinterState {
  if (status?.connected !== true) throw new Error("A connected printer is required for safety validation.");
  const observation = status.observation;
  const now = Date.now();
  if (!observation || observation.source !== "mqtt" || !Number.isFinite(observation.requestedAt) || !Number.isFinite(observation.receivedAt) ||
      observation.receivedAt < observation.requestedAt || observation.receivedAt > now || now - observation.requestedAt > MAX_REPORT_AGE_MS) {
    throw new Error("A fresh observed MQTT report is required; cached or stale status cannot authorize an operation.");
  }
  if (!object(status.raw)) throw new Error("Fresh raw printer report is missing.");
  const raw = status.raw;
  const identity = observedIdentity(raw, String(status.serial ?? ""));
  const model = normalizeModel(requirements.model);
  if (!model || !identity.model || model !== identity.model) throw new Error(`Printer model identity mismatch: requested ${requirements.model}, observed ${identity.model ?? "unknown"}.`);
  const hmsWarnings = validateErrors(raw, requirements.requireIdle !== false, requirements.uploadOnly === true);
  if (requirements.requireLoadedFilament && (raw.ams?.tray_now !== undefined || Array.isArray(raw.ams?.ams))) {
    const current = finiteNumber(raw.ams?.tray_now);
    if (current === 255) throw new Error("The nozzle is explicitly reported unloaded. Load the declared filament before starting or resuming this G-code job.");
    if (current === undefined || !Number.isInteger(current) || current < 0 || current > 254) {
      throw new Error("Cannot verify the currently loaded AMS tray before starting or resuming this G-code job.");
    }
    if ((requirements.usedFilamentPositions ?? []).some(position => current !== (requirements.useAMS ? requirements.amsMapping?.[position] : 254))) {
      throw new Error("The currently loaded spool differs from the tray checked for this G-code job.");
    }
  }
  const nozzles = requirements.nozzleDiameters.length ? reportedNozzles(raw) : [];
  if (requirements.nozzleDiameters.length && ["h2d","h2dpro","h2c","x2d"].includes(model) &&
      !Array.isArray(raw.device?.nozzle?.info) && !Array.isArray(raw.nozzle_diameter)) {
    throw new Error("A scalar legacy nozzle report is ambiguous for this multi-nozzle printer; fresh per-nozzle configuration is required.");
  }
  // Without a physical selection, a scalar file requirement must match every reported nozzle.
  const broadcast = !requirements.usedNozzleIndices && requirements.nozzleDiameters.length === 1 && nozzles.length > 1;
  const expectedDiameters = broadcast ? nozzles.map(() => requirements.nozzleDiameters[0]) : requirements.nozzleDiameters;
  // Sliced files list extruders left to right; dual-nozzle printers report their right (main) nozzle as id 0 and
  // their left (deputy) as id 1. Studio maps logical extruder i to physical_extruder_map[i], ["1","0"] on H2D, H2D Pro,
  // H2C and X2D (fdm_bbl_3dp_002_common.json; DevNozzle::AtLeftExtruder is id 1). Verified on an H2C: id 0 carries the
  // hotend rack (ids 16+) and the AMS, id 1 the external spool.
  const extruderMap = requirements.nozzleDiameters.length === extruderCount(model) ? physicalExtruderMap(model, requirements.physicalExtruderMap) : undefined;
  const physicalIndex = (position: number) => extruderMap?.[position] ?? position;
  const indices = requirements.usedNozzleIndices ?? (broadcast ? nozzles.map(nozzle => nozzle.index) : requirements.nozzleDiameters.map((_, index) => physicalIndex(index)));
  if (indices.length !== expectedDiameters.length || (!requirements.usedNozzleIndices && nozzles.length !== expectedDiameters.length)) {
    throw new Error("Nozzle selection is missing or ambiguous; specify each used nozzle and verify its reported diameter.");
  }
  // Bambu Studio (SelectMachine.cpp CheckErrorExtruderNozzleWithSlicing) checks only the extruders the plate's used
  // filaments run on, and only diameter and flow; nozzle material feeds a hardness warning. An unreliable report is a
  // warning (PrintStatusHasUnreliableNozzleWarning); an abnormal or unknown nozzle on a used extruder blocks here.
  const dualJob = !!extruderMap && extruderMap.length === 2 && !requirements.usedNozzleIndices;
  const usedFilaments = requirements.usedFilamentPositions ?? (requirements.materials ?? []).map((_, index) => index);
  const filamentsOn = (position: number) => dualJob && requirements.filamentMap
    ? usedFilaments.filter(filament => requirements.filamentMap![filament] === position + 1) : usedFilaments;
  const checked = expectedDiameters.map((_, position) => position).filter(position => !dualJob || !requirements.filamentMap || filamentsOn(position).length > 0);
  const rack = NOZZLE_RACK_MODELS.has(model) ? reportedNozzles(raw, true) : [];
  const usable = (nozzle: ReportedNozzle, diameter: number, flow: string) => (nozzle.stat === undefined || ((nozzle.stat >>> 1) & 3) === 0) &&
    Math.abs(nozzle.diameter - diameter) <= 0.0001 && (requirements.nozzleFlows === undefined || flow === nozzle.flow);
  for (const position of checked) {
    const diameter = expectedDiameters[position];
    const physical = indices[position];
    const expectedType = token(requirements.nozzleTypes?.[broadcast ? 0 : position]);
    const expectedFlow = token(requirements.nozzleFlows?.[broadcast ? 0 : position]);
    if (!Number.isFinite(diameter) || diameter <= 0) throw new Error(`Printer nozzle ${physical} diameter does not match the job (${diameter} mm).`);
    if (requirements.nozzleTypes !== undefined && !NOZZLE_TYPES.includes(expectedType)) throw new Error(`The job's nozzle type for printer nozzle ${physical} is unknown.`);
    if (requirements.nozzleFlows !== undefined && !NOZZLE_FLOWS.includes(expectedFlow)) throw new Error(`Printer nozzle ${physical} flow variant is unknown or does not match the job.`);
    const mounted = nozzles.find(value => value.index === physical);
    let selected: ReportedNozzle[];
    if (rack.length && physical === MAIN_EXTRUDER_ID && !requirements.usedNozzleIndices) {
      // The H2C's right extruder swaps hotends from its rack: Studio accepts the job when the mounted hotend or any rack
      // hotend matches (DevNozzleSystem::CollectNozzles skips abnormal ones), and blocks while the rack is being read or
      // when the toolhead and all six rack places are full.
      const state = finiteNumber(raw.device?.nozzle?.state);
      if (state !== undefined && ((state >>> 4) & 0xf) > 0) throw new Error("The printer is still reading its hotend rack; wait for it to finish and retry.");
      selected = [mounted, ...rack].filter((nozzle): nozzle is ReportedNozzle => !!nozzle && usable(nozzle, diameter, expectedFlow));
      if (!selected.length) throw new Error(`No mounted or rack hotend on the right nozzle matches the job (${diameter} mm${requirements.nozzleFlows !== undefined ? `, ${expectedFlow}` : ""}).`);
      if (mounted && rack.filter(nozzle => nozzle.index <= 21).length >= 6) throw new Error("The toolhead and hotend rack are full. Remove at least one hotend before printing.");
    } else {
      if (!mounted || Math.abs(mounted.diameter - diameter) > 0.0001) throw new Error(`Printer nozzle ${physical} diameter does not match the job (${diameter} mm).`);
      if (mounted.stat !== undefined && ((mounted.stat >>> 1) & 3) !== 0) throw new Error(`Printer nozzle ${physical} is reported abnormal or unknown; refresh or replace it before printing.`);
      if (requirements.nozzleTypes !== undefined && !mounted.type) throw new Error(`Printer nozzle ${physical} type is unknown; the printer must report its installed nozzle.`);
      if (requirements.nozzleFlows !== undefined && expectedFlow !== mounted.flow) throw new Error(`Printer nozzle ${physical} flow variant is unknown or does not match the job.`);
      selected = [mounted];
    }
    if (selected.every(nozzle => nozzle.stat !== undefined && (nozzle.stat & 1) !== 0)) hmsWarnings.push(`nozzle ${physical} information is unreliable (refresh the nozzle information on the printer)`);
    // Studio's hardness check (is_nozzle_hrc_matched) warns, never blocks: the filament is harder than the nozzle.
    for (const filament of filamentsOn(position)) {
      const material = requirements.filamentTypes?.[filament] ?? requirements.materials?.[filament];
      const required = requiredNozzleHrc(material, requirements.filamentIds?.[filament]);
      const nozzle = selected.find(value => value.type) ?? selected[0];
      if (nozzle.type && NOZZLE_HRC[nozzle.type] < required) {
        hmsWarnings.push(`${material} is harder than nozzle ${physical} (${nozzle.type.replace("steel", " steel").replace("tungstencarbide", "tungsten carbide")}); it may wear the nozzle`);
      }
    }
  }
  const filaments: ReportedFilament[] = [];
  // Heating the bed alone has no filament requirement. All other callers declare each used material.
  if (requirements.verifyMaterials !== false && (requirements.materials !== undefined || requirements.nozzleDiameters.length)) {
    const materials = requirements.materials ?? [];
    const positions = requirements.usedFilamentPositions ?? materials.map((_, index) => index);
    if (!positions.length) throw new Error("A declared material is required for each used filament or external spool.");
    for (const position of positions) {
      const material = normalizeMaterial(materials[position]);
      if (!Number.isInteger(position) || position < 0 || !material) throw new Error(`A known declared material is required for filament position ${position}.`);
      const trayIndex = requirements.useAMS ? requirements.amsMapping?.[position] : (requirements.amsMapping?.[position] ?? 254);
      if (trayIndex === undefined || !Number.isInteger(trayIndex) || trayIndex < 0 || trayIndex > 255) throw new Error(`Complete AMS mapping is required for filament position ${position}.`);
      if (!requirements.useAMS && !isExternalTray(trayIndex)) throw new Error(`Filament position ${position} must map to an external spool holder when AMS is off.`);
      const tray = isExternalTray(trayIndex) ? externalTray(raw,model,trayIndex) : mappedTray(raw,trayIndex);
      if (DUAL_EXTRUDER_MODELS.has(model) && !requirements.usedNozzleIndices) assertFeedsExtruder(raw, model, trayIndex, physicalExtruderMap(model, requirements.physicalExtruderMap)[(requirements.filamentMap?.[position] ?? 1) - 1], position);
      const reportedType = typeof tray?.tray_type === "string" ? tray.tray_type.trim() : "";
      if (reportedType && normalizeMaterial(reportedType) !== material) throw new Error(`Reported material ${reportedType} in slot ${trayIndex} contradicts declared ${materials[position]}.`);
      if (!requirements.usedNozzleIndices) {
        const dual = DUAL_EXTRUDER_MODELS.has(model);
        const logical = dual ? (requirements.filamentMap?.[position] ?? 1) - 1 : 0;
        const physical = dual ? physicalExtruderMap(model, requirements.physicalExtruderMap)[logical] : MAIN_EXTRUDER_ID;
        const nozzle = nozzles.find(value => value.index === physical);
        const prohibition = filamentProhibition({
          model, external: isExternalTray(trayIndex),
          type: reportedType || requirements.filamentTypes?.[position] || materials[position],
          name: requirements.filamentNames?.[position],
          filamentId: (typeof tray?.tray_info_idx === "string" && tray.tray_info_idx.trim()) || requirements.filamentIds?.[position],
          nozzleFlow: nozzle?.flow ?? (requirements.nozzleFlows?.[logical] !== undefined ? token(requirements.nozzleFlows[logical]) : undefined),
          nozzleDiameter: nozzle?.diameter ?? requirements.nozzleDiameters[logical],
        });
        if (prohibition) throw new Error(`Filament ${position + 1} (${reportedType || requirements.filamentNames?.[position] || materials[position]}) can't be printed this way: ${prohibition}`);
      }
      const nozzleMin = trayRange(tray?.nozzle_temp_min,"minimum");
      const nozzleMax = trayRange(tray?.nozzle_temp_max,"maximum");
      if (nozzleMin !== undefined && nozzleMax !== undefined && nozzleMin > nozzleMax) throw new Error(`Reported filament temperature range in slot ${trayIndex} is invalid.`);
      filaments.push({position,material,trayIndex,nozzleMin,nozzleMax});
    }
  }
  return {model,reportedNozzles:nozzles,filaments,hmsWarnings};
}

/**
 * Manual nozzle heating cannot remap filament slots: validate the material already at the nozzle. Dual-nozzle printers
 * need the nozzle (extruder 0 right/main, 1 left/deputy); its loaded tray comes from device.extruder.info[].snow
 * (AMS id << 8 | slot; 0xFFFF none), as Studio's ExtderSystemParser reads it.
 */
export function manualHeatingRequirements(status: any, model: string, nozzleDiameter: number, material: string, extruder?: number): PrinterStateRequirements {
  const normalized = normalizeModel(model);
  if (!normalized) throw new Error("A known printer model is required for manual nozzle heating.");
  const raw = status?.raw;
  if (!object(raw)) throw new Error("A fresh printer report is required for manual nozzle heating.");
  if (DUAL_EXTRUDER_MODELS.has(normalized)) {
    if (extruder !== 0 && extruder !== 1) throw new Error("Choose the nozzle to heat on this dual-nozzle printer (extruder left or right).");
    const entries = raw.device?.extruder?.info;
    const entry = Array.isArray(entries) ? entries.filter((value: any) => Number(value?.id) === extruder) : [];
    const snow = entry.length === 1 ? finiteNumber(entry[0].snow) : undefined;
    if (snow === undefined || !Number.isInteger(snow) || snow < 0 || snow > 0xffff) {
      throw new Error("Cannot identify the filament loaded at that nozzle; refresh the printer's extruder state.");
    }
    const requirements: PrinterStateRequirements = {
      model: normalized, nozzleDiameters: [nozzleDiameter], usedNozzleIndices: [extruder],
      materials: [material], usedFilamentPositions: [0], useAMS: false,
    };
    const ams = snow >> 8;
    const slot = snow & 0xff;
    // Nothing loaded: the declared material keeps its ceiling, but there is no spool to compare it with.
    if (ams === 0xff && slot === 0xff) return { ...requirements, verifyMaterials: false };
    if (isExternalTray(ams)) return { ...requirements, amsMapping: [ams] };
    const tray = ams >= 128 && ams <= 135 ? ams : ams <= 3 && slot <= 3 ? ams * 4 + slot : undefined;
    if (tray === undefined) throw new Error("The printer reports an unknown filament source at that nozzle; refresh its extruder state.");
    return { ...requirements, useAMS: true, amsMapping: [tray] };
  }
  if (extruder !== undefined && extruder !== 0) throw new Error("This printer has one nozzle.");
  if (reportedNozzles(raw).some(nozzle => nozzle.index !== 0)) {
    throw new Error("Manual heating cannot verify the active nozzle and loaded material on this multi-nozzle printer. Use a checked sliced print instead.");
  }
  const requirements: PrinterStateRequirements = {
    model: normalized, nozzleDiameters: [nozzleDiameter], usedNozzleIndices: [0],
    materials: [material], usedFilamentPositions: [0], useAMS: false,
  };
  const current = raw.ams?.tray_now;
  if (current === undefined && !Array.isArray(raw.ams?.ams)) return requirements;
  const tray = finiteNumber(current);
  if (tray === undefined || !Number.isInteger(tray) || tray < 0 || tray > 255) {
    throw new Error("Cannot identify the currently loaded AMS tray for manual heating; refresh the printer's filament state.");
  }
  // 254 is external spool; 255 means no filament loaded. The caller must still declare a material.
  if (tray < 254) { requirements.useAMS = true; requirements.amsMapping = [tray]; }
  return requirements;
}
