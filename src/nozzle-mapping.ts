/**
 * Hotend-rack nozzle mapping (H2C). The right extruder of a rack printer swaps among the mounted hotend and the rack's
 * (ids 16-21), so before a job that prints on it Bambu Studio asks the printer which hotend each filament gets:
 * `get_auto_nozzle_mapping` (DevNozzleMappingCtrl::CtrlGetAutoNozzleMappingV0, or V1 with a dynamic filament map),
 * waits for the reply with the same sequence_id (ParseAutoNozzleMapping) and sends the reply's `mapping` as the job's
 * `nozzle_mapping` (SelectMachineDialog: m_print_job->task_nozzle_mapping = GetNozzleMappingJson().dump()). The
 * request only reads: the printer computes a table from its hotends and the job's filaments, nothing moves.
 *
 * Rack support is push_status `fun` bit 60 (DeviceManager.cpp: SetSupportNozzleRack(get_flag_bits(fun, 60))).
 */
import { NOZZLE_RACK_MODELS, MAIN_EXTRUDER_ID, physicalExtruderMap, extruderCount, isExternalTray } from "./safety/models.js";
import type { SliceNozzlePlan } from "./safety/slice-info.js";

/** What the request needs from the inspected job. */
export interface NozzleMappingJob {
  model: string;
  nozzleDiameters: number[];
  usedFilamentPositions: number[];
  /** Per filament: the sliced extruder, 1 = left. */
  filamentMap?: number[];
  physicalExtruderMap?: number[];
  nozzlePlan?: SliceNozzlePlan;
}

/** Firmware error numbers of a failed mapping (DevNozzleMappingCtrl::ErrNoV1). */
const MAPPING_ERRORS: Record<number, string> = {
  1: "the printer could not read the job's 3MF",
  2: "the printer does not support this request version",
  3: "a nozzle group id in the request is invalid",
  4: "no hotend on the printer can print the job",
  5: "the printer could not read the request",
  6: "the hotend rack calibration failed",
  7: "the hotend rack is moving",
  8: "the hotend rack is full",
  9: "the printer has fewer suitable hotends than the job plans",
};

/** The printer answers this request on its report topic. */
export interface AutoNozzleMappingReply {
  result?: string;
  reason?: string;
  errno?: number;
  type?: string;
  version?: number;
  detail?: unknown;
  mapping?: unknown;
}

const flowNames: Record<string, string> = { standard: "Standard", highflow: "High Flow", tpuhighflow: "TPU High Flow", e3dhighflow: "E3D High Flow" };
const flowToken = (value: unknown) => String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
/** DevNozzle flow from a reported type code (HS01 = Standard hardened steel; s_parse_nozzle_type). */
function reportedFlow(type: unknown): string | undefined {
  const text = String(type ?? "");
  if (!/^H[A-Z]\d\d/i.test(text)) return undefined;
  return ({ S: "Standard", A: "Standard", X: "Standard", H: "High Flow", E: "High Flow", U: "TPU High Flow", B: "E3D High Flow" } as Record<string, string>)[text[1].toUpperCase()];
}
const diameterText = (value: number) => value.toFixed(2);

/** Whether the printer swaps right-side hotends from a rack: its report's `fun` bit 60, on a rack model. */
export function nozzleRackSupported(raw: Record<string, any> | undefined, model: string): boolean {
  const fun = raw?.fun;
  if (!NOZZLE_RACK_MODELS.has(model) || typeof fun !== "string" || !/^[0-9a-f]{1,16}$/i.test(fun.trim())) return false;
  return ((BigInt(`0x${fun.trim()}`) >> 60n) & 1n) === 1n;
}

/** The sliced (logical, 1-based) extruder whose physical nozzle is the main/right one that carries the rack. */
function rackExtruder(job: NozzleMappingJob): number | undefined {
  const count = extruderCount(job.model);
  if (job.nozzleDiameters.length !== count) return undefined;
  const map = physicalExtruderMap(job.model, job.physicalExtruderMap);
  const index = map.indexOf(MAIN_EXTRUDER_ID);
  return index < 0 ? undefined : index + 1;
}

/**
 * Studio requests a mapping when the rack is supported and the job prints on the rack extruder (V0), or always with a
 * dynamic filament map (V1). Returns the version to ask for, or undefined when no mapping is needed.
 */
export function nozzleMappingVersion(raw: Record<string, any> | undefined, job: NozzleMappingJob): 0 | 1 | undefined {
  if (!nozzleRackSupported(raw, job.model)) return undefined;
  if (job.nozzlePlan?.dynamicNozzleMap) return 1;
  const right = rackExtruder(job);
  if (right === undefined) return undefined;
  const usesRight = job.nozzlePlan?.nozzles.length
    ? job.nozzlePlan.nozzles.some(nozzle => nozzle.extruder === right)
    : job.usedFilamentPositions.some(position => (job.filamentMap?.[position] ?? (extruderCount(job.model) === 1 ? 1 : undefined)) === right);
  return usesRight ? 0 : undefined;
}

/** A tray index (0-15 AMS, 128-135 AMS-HT, 254/255 external) as Studio's `ams_id << 8 | slot_id`. */
function trayCode(tray: number): number {
  if (isExternalTray(tray)) return tray << 8;
  if (tray >= 128) return tray << 8;
  return (Math.floor(tray / 4) << 8) | (tray % 4);
}

function trayReport(raw: Record<string, any>, tray: number): Record<string, any> | undefined {
  if (isExternalTray(tray)) {
    const slots = Array.isArray(raw.vir_slot) ? raw.vir_slot : raw.vt_tray ? [raw.vt_tray] : [];
    return slots.find((slot: any) => Number(slot?.id) === tray) ?? (slots.length === 1 ? slots[0] : undefined);
  }
  const unit = tray >= 128 ? tray : Math.floor(tray / 4);
  const slot = tray >= 128 ? 0 : tray % 4;
  const ams = (Array.isArray(raw.ams?.ams) ? raw.ams.ams : []).find((value: any) => Number(value?.id) === unit);
  return (Array.isArray(ams?.tray) ? ams.tray : []).find((value: any) => Number(value?.id) === slot);
}

/** The reported hotends Studio lists in the request: normal ones (stat bits 1-2 clear), mounted then rack. */
function requestNozzles(raw: Record<string, any>): Record<string, unknown>[] {
  const info = Array.isArray(raw.device?.nozzle?.info) ? raw.device.nozzle.info : [];
  const target = Number.isInteger(Number(raw.device?.nozzle?.tar_id)) && raw.device?.nozzle?.tar_id !== undefined ? Number(raw.device.nozzle.tar_id) : undefined;
  const normal = (entry: any) => {
    const diameter = Number(entry?.diameter);
    if (!Number.isFinite(diameter) || diameter <= 0) return false;
    const stat = Number(entry?.stat ?? 0);
    return Number.isInteger(stat) && ((stat >>> 1) & 3) === 0;
  };
  const entry = (nozzle: any, pos: number) => ({
    pos,
    nozzle_d: diameterText(Number(nozzle.diameter)),
    nozzle_v: reportedFlow(nozzle.type) ?? "",
    wear: Number.isFinite(Number(nozzle.wear)) ? Number(nozzle.wear) : 0,
    cate: typeof nozzle.fila_id === "string" ? nozzle.fila_id : "",
    color: typeof nozzle.color_m === "string" ? nozzle.color_m : "",
  });
  const mounted = info.filter((nozzle: any) => Number(nozzle?.id) < 16 && normal(nozzle))
    // The mounted main hotend is named by the rack place it came from (tar_id), as the protocol defines.
    .map((nozzle: any) => entry(nozzle, Number(nozzle.id) === MAIN_EXTRUDER_ID && target !== undefined ? target : Number(nozzle.id)));
  const rack = info.filter((nozzle: any) => Number(nozzle?.id) >= 16 && normal(nozzle)).map((nozzle: any) => entry(nozzle, Number(nozzle.id)));
  return [...mounted, ...rack];
}

/**
 * Build `get_auto_nozzle_mapping`. `amsMapping` is the checked positional tray mapping (one tray index per
 * filament position); `calibration` the job's flow-calibration choice (0 off, 1 on, 2 auto) and `paValue` its
 * extrude_cali_manual_mode (0 = the printer's own pressure advance, Studio's default).
 */
export function buildAutoNozzleMappingRequest(raw: Record<string, any>, job: NozzleMappingJob, amsMapping: number[], options: {
  version: 0 | 1; sequenceId: string; calibration: number; paValue: number;
}): { print: Record<string, unknown> } {
  const plan = job.nozzlePlan;
  if (!plan || !plan.nozzles.length) throw new Error("The sliced file has no nozzle plan (slice_info.config) to ask the printer for a hotend mapping; re-slice it with Bambu Studio 02.08 or later.");
  if (options.version === 1) {
    // CtrlGetAutoNozzleMappingV1: one entry per used logical nozzle group.
    return { print: {
      command: "get_auto_nozzle_mapping",
      sequence_id: options.sequenceId,
      group_info: plan.nozzles.map(nozzle => ({
        id: nozzle.id, ext: nozzle.extruder, dia: nozzle.diameter,
        vol: nozzle.flow === "high_flow" ? "High Flow" : nozzle.flow === "tpu_high_flow" ? "TPU Flow" : "Standard",
      })),
      version: 1,
    } };
  }
  const positions = [...job.usedFilamentPositions].sort((a, b) => a - b);
  // filament_seq: the first index at which each filament (1-based) comes up in the change sequence, -1 for the rest.
  const sequence = plan.filamentChangeSequence?.length ? plan.filamentChangeSequence : positions;
  const firstUse: number[] = [];
  sequence.forEach((position, index) => { if (firstUse[position + 1] === undefined) firstUse[position + 1] = index; });
  const highest = Math.max(0, ...sequence.map(position => position + 1));
  const filamentSeq = Array.from({ length: highest + 1 }, (_, id) => firstUse[id] ?? -1);
  // ams_mapping: 33 entries the firmware asks to be filled with 0xFFFF, the used ones at position + 1.
  const trays = Array(33).fill(0xffff);
  const filaInfo: Record<string, unknown>[] = [];
  for (const position of positions) {
    const tray = amsMapping[position];
    if (!Number.isInteger(tray) || tray < 0) throw new Error(`Filament ${position + 1} has no checked tray for the hotend mapping request.`);
    if (position + 1 < trays.length) trays[position + 1] = trayCode(tray);
    const group = plan.filamentNozzles[position];
    const nozzle = plan.nozzles.find(value => value.id === group)
      ?? (plan.nozzles.filter(value => value.extruder === job.filamentMap?.[position]).length === 1
        ? plan.nozzles.find(value => value.extruder === job.filamentMap?.[position]) : undefined);
    if (!nozzle) throw new Error(`The sliced file does not say which nozzle filament ${position + 1} prints with; re-slice it with Bambu Studio 02.08 or later.`);
    const report = trayReport(raw, tray);
    filaInfo.push({
      id: position + 1,
      direction: nozzle.extruder === 1 ? 1 : 2,
      group: nozzle.id,
      nozzle_d: diameterText(nozzle.diameter),
      nozzle_v: nozzle.flow === "high_flow" ? "High Flow" : "Standard",
      cate: typeof report?.tray_info_idx === "string" ? report.tray_info_idx : "",
      color: typeof report?.tray_color === "string" ? report.tray_color : "",
    });
  }
  return { print: {
    command: "get_auto_nozzle_mapping",
    sequence_id: options.sequenceId,
    calibration: options.calibration,
    extrude_cali_manual_mode: options.paValue,
    filament_seq: filamentSeq,
    ams_mapping: trays,
    fila_info: filaInfo,
    nozzle_info: requestNozzles(raw),
  } };
}

/** The reply to the request numbered `sequenceId` in a printer message (an object or its JSON), if this is it. */
export function matchAutoNozzleMappingReply(message: unknown, sequenceId: string): AutoNozzleMappingReply | undefined {
  let parsed: any = message;
  if (typeof message === "string" || Buffer.isBuffer(message)) {
    try { parsed = JSON.parse(String(message)); } catch { return undefined; }
  }
  const print = parsed?.print;
  if (!print || typeof print !== "object" || print.command !== "get_auto_nozzle_mapping" || String(print.sequence_id) !== sequenceId) return undefined;
  // The request echoed back carries no outcome.
  if (print.result === undefined && print.mapping === undefined && print.errno === undefined && print.reason === undefined) return undefined;
  return {
    ...(print.result !== undefined ? { result: String(print.result) } : {}),
    ...(print.reason !== undefined ? { reason: String(print.reason) } : {}),
    ...(Number.isInteger(Number(print.errno)) && print.errno !== undefined ? { errno: Number(print.errno) } : {}),
    ...(print.type !== undefined ? { type: String(print.type) } : {}),
    ...(Number.isInteger(Number(print.version)) && print.version !== undefined ? { version: Number(print.version) } : {}),
    ...(print.detail !== undefined ? { detail: print.detail } : {}),
    ...(print.mapping !== undefined ? { mapping: print.mapping } : {}),
  };
}

export interface CheckedNozzleMapping {
  /** The reply's table, sent as the job's nozzle_mapping. */
  mapping: number[];
  version: 0 | 1;
  /** Per used filament (V0) or nozzle group (V1): Studio's label, L, R or R<n> for rack place n. */
  assignments: { filament?: number; nozzleGroup?: number; hotend: string }[];
  warnings: string[];
}

/**
 * Check the printer's answer the way Studio's print dialog does (CheckErrorSyncNozzleMappingResultV0/V1): "failed"
 * (the request didn't reach the mapping) and "fail" (the printer couldn't build it) refuse the job, as does an empty
 * table. Every filament the job prints on the rack must also be mapped to a hotend that is there and matches the
 * filament's sliced nozzle (diameter and flow).
 */
export function checkAutoNozzleMappingReply(reply: AutoNozzleMappingReply, raw: Record<string, any>, job: NozzleMappingJob, version: 0 | 1): CheckedNozzleMapping {
  const result = (reply.result ?? "").trim().toLowerCase();
  const errno = reply.errno !== undefined ? ` (code ${reply.errno}${MAPPING_ERRORS[reply.errno] ? `: ${MAPPING_ERRORS[reply.errno]}` : ""})` : "";
  if (result === "failed") throw new Error(`The printer did not return a hotend mapping for this job${reply.reason ? ` (${reply.reason})` : ""}. Refresh the printer information and try again.`);
  if (result === "fail") throw new Error(`The printer could not map this job's filaments to its hotends${errno}. Refresh the hotend information on the printer, or re-slice for the hotends it has.`);
  const mapping = reply.mapping;
  if (!Array.isArray(mapping) || mapping.length === 0 || mapping.some(value => !Number.isInteger(value))) {
    throw new Error("The printer returned an empty or malformed hotend mapping table for this job; refresh the printer information and try again.");
  }
  const warnings = reply.errno === 9 ? [`hotend mapping: ${MAPPING_ERRORS[9]}`] : [];
  const info = Array.isArray(raw.device?.nozzle?.info) ? raw.device.nozzle.info : [];
  const target = raw.device?.nozzle?.tar_id !== undefined && Number.isInteger(Number(raw.device.nozzle.tar_id)) ? Number(raw.device.nozzle.tar_id) : undefined;
  const hotend = (pos: number) => {
    // The mounted main hotend may be named by its rack place (tar_id).
    const id = target !== undefined && pos === target ? MAIN_EXTRUDER_ID : pos;
    const nozzle = info.find((entry: any) => Number(entry?.id) === id);
    const label = id === MAIN_EXTRUDER_ID ? "R" : id === 1 ? "L" : id >= 16 ? `R${id - 16 + 1}` : `nozzle ${id}`;
    return { nozzle, label };
  };
  const plan = job.nozzlePlan!;
  const assignments: CheckedNozzleMapping["assignments"] = [];
  const checkHotend = (pos: number, needed: { diameter: number; flow: string }, what: string) => {
    const { nozzle, label } = hotend(pos);
    if (!nozzle) throw new Error(`The printer's hotend mapping puts ${what} on ${label}, which it does not report. Refresh the hotend information and try again.`);
    const flow = reportedFlow(nozzle.type);
    if (Math.abs(Number(nozzle.diameter) - needed.diameter) > 0.0001 || (flow !== undefined && needed.flow && flowToken(flow) !== flowToken(needed.flow))) {
      throw new Error(`The printer's hotend mapping puts ${what} on ${label} (${Number(nozzle.diameter)} mm ${flow ?? "unknown flow"}), but it is sliced for ${needed.diameter} mm ${flowNames[flowToken(needed.flow)] ?? needed.flow}.`);
    }
    return label;
  };
  if (version === 1) {
    for (const nozzle of plan.nozzles) {
      const pos = mapping[nozzle.id];
      if (pos === undefined || pos < 0) throw new Error(`The printer's hotend mapping leaves nozzle group ${nozzle.id} without a hotend.`);
      assignments.push({ nozzleGroup: nozzle.id, hotend: checkHotend(pos, nozzle, `nozzle group ${nozzle.id}`) });
    }
    return { mapping, version, assignments, warnings };
  }
  const right = rackExtruder(job);
  for (const position of [...job.usedFilamentPositions].sort((a, b) => a - b)) {
    const nozzle = plan.nozzles.find(value => value.id === plan.filamentNozzles[position]);
    const extruder = nozzle?.extruder ?? job.filamentMap?.[position];
    if (extruder === undefined || extruder !== right) {
      assignments.push({ filament: position + 1, hotend: "L" });
      continue;
    }
    const pos = mapping[position];
    if (pos === undefined || pos < 0) throw new Error(`The printer's hotend mapping leaves filament ${position + 1} without a hotend.`);
    const needed = nozzle ?? { diameter: job.nozzleDiameters[extruder - 1], flow: "" };
    assignments.push({ filament: position + 1, hotend: checkHotend(pos, needed, `filament ${position + 1}`) });
  }
  return { mapping, version, assignments, warnings };
}

/** How long to wait for the printer's mapping (BAMBU_NOZZLE_MAPPING_MS, default 15 s, at most 60 s). */
export function nozzleMappingWaitMs(): number {
  const raw = process.env.BAMBU_NOZZLE_MAPPING_MS?.trim();
  const value = raw ? Number(raw) : NaN;
  return Number.isInteger(value) && value > 0 && value <= 60_000 ? value : 15_000;
}

/** A transport that sends one printer command and resolves with the first message `match` accepts, or undefined. */
export type PrinterQuery = (message: { print: Record<string, unknown> }, match: (message: unknown) => AutoNozzleMappingReply | undefined, waitMs: number) => Promise<AutoNozzleMappingReply | undefined>;

/**
 * Ask the printer for the job's hotend mapping when it needs one. Undefined when it doesn't (no rack, or nothing
 * prints on the rack extruder). No answer within the wait is reported, not fatal: the printer then picks the hotends
 * itself, as it did for jobs sent without a mapping; a refusal or a mapping that contradicts the job throws.
 */
export async function requestNozzleMapping(raw: Record<string, any>, job: NozzleMappingJob, amsMapping: number[], options: {
  sequenceId: string; calibration: number; paValue: number; query: PrinterQuery; waitMs?: number;
}): Promise<{ checked?: CheckedNozzleMapping; warning?: string } | undefined> {
  const version = nozzleMappingVersion(raw, job);
  if (version === undefined) return undefined;
  const waitMs = options.waitMs ?? nozzleMappingWaitMs();
  let request: { print: Record<string, unknown> };
  try {
    request = buildAutoNozzleMappingRequest(raw, job, amsMapping, { version, sequenceId: options.sequenceId, calibration: options.calibration, paValue: options.paValue });
  } catch (error) {
    return { warning: `no hotend mapping was requested: ${error instanceof Error ? error.message : String(error)} The job was sent without one and the printer picks its hotends itself` };
  }
  let reply: AutoNozzleMappingReply | undefined;
  try {
    reply = await options.query(request, message => matchAutoNozzleMappingReply(message, options.sequenceId), waitMs);
  } catch (error) {
    return { warning: `could not ask the printer for a hotend mapping (${error instanceof Error ? error.message : String(error)}); the job was sent without one and the printer picks its hotends itself` };
  }
  if (!reply) {
    return { warning: `the printer did not answer get_auto_nozzle_mapping within ${waitMs / 1000} s; the job was sent without a hotend mapping and the printer picks its hotends itself` };
  }
  const checked = checkAutoNozzleMappingReply(reply, raw, job, version);
  return { checked, ...(checked.warnings.length ? { warning: checked.warnings.join("; ") } : {}) };
}
