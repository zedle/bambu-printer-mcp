/**
 * Per-extruder nozzle and filament-to-extruder settings for slicing.
 *
 * Dual-nozzle Bambu printers (H2D, H2D Pro, H2C, X2D) can carry a different
 * hotend on each side: the H2C, for example, has a fixed High Flow nozzle on
 * the left and a rack of Standard hotends on the right. Bambu Studio describes
 * that per extruder (`nozzle_volume_type`, `nozzle_type` rows chosen through
 * `printer_extruder_id`) and assigns each filament to an extruder
 * (`filament_map`, `filament_map_mode`). This module parses the tool
 * arguments and the printer's report into that shape; profile-flatten applies
 * and checks it against the selected machine profile.
 *
 * Order: "logical" extruders are Bambu Studio's, numbered from 1 and listed
 * left to right. "Physical" ids are the firmware's nozzle ids (0 = main/right,
 * 1 = deputy/left on dual-nozzle printers); the machine profile's
 * `physical_extruder_map` links the two.
 */

import { reportedNozzles } from "../safety/printer-state.js";

/** Bambu Studio's NozzleVolumeType names. */
export const NOZZLE_FLOWS = ["Standard", "High Flow", "TPU High Flow", "E3D High Flow"] as const;
/** Bambu Studio's nozzle_type names (hotend material). */
export const NOZZLE_MATERIALS = ["stainless_steel", "hardened_steel", "tungsten_carbide", "brass"] as const;

/** One extruder's nozzle. Missing fields keep the printer report or the machine profile's value. */
export interface ExtruderNozzle {
  diameter?: number;
  /** One of NOZZLE_FLOWS. */
  flow?: string;
  /** One of NOZZLE_MATERIALS. */
  type?: string;
}

/** Where a filament slot is loaded from. `unit` selects one AMS unit by its reported id. */
export type FilamentSource = { kind: "ams"; unit?: number } | { kind: "external" };

/** A printer report, by firmware (physical) nozzle id. */
export interface ReportedExtruders {
  nozzles: { physical: number; diameter: number; flow?: string; type?: string }[];
  /** Physical extruders each AMS unit feeds; undefined when the report doesn't say. */
  ams: { unit: number; physical: number[] | undefined }[];
  /** External spool holders, by the physical extruder they feed. */
  external: { physical: number; loaded: boolean }[];
}

const token = (value: unknown) => String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");

const FLOW_BY_TOKEN: Record<string, string> = {
  standard: "Standard",
  highflow: "High Flow",
  hf: "High Flow",
  tpuhighflow: "TPU High Flow",
  e3dhighflow: "E3D High Flow",
};

export function normalizeNozzleFlow(value: unknown): string {
  const flow = FLOW_BY_TOKEN[token(value)];
  if (!flow) throw new Error(`Unknown nozzle flow "${String(value)}". Valid flows: ${NOZZLE_FLOWS.join(", ")}.`);
  return flow;
}

export function normalizeNozzleMaterial(value: unknown): string {
  const material = NOZZLE_MATERIALS.find(name => token(name) === token(value));
  if (!material) throw new Error(`Unknown nozzle type "${String(value)}". Valid types: ${NOZZLE_MATERIALS.join(", ")}.`);
  return material;
}

function parseListArg(value: unknown, label: string): unknown[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const text = value.trim();
    if (text.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed;
      } catch { /* reported below */ }
      throw new Error(`${label} must be an array.`);
    }
    return text.split(/[;,]/).map(part => part.trim()).filter(Boolean);
  }
  if (typeof value === "number") return [value];
  throw new Error(`${label} must be an array.`);
}

/** The `nozzles` tool argument: one object per extruder, left first. */
export function parseExtruderNozzlesArg(value: unknown): ExtruderNozzle[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  let list: unknown = value;
  if (typeof value === "string") {
    try { list = JSON.parse(value); } catch { throw new Error("nozzles must be an array of {diameter, flow, type} objects, left extruder first."); }
  }
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("nozzles must be a nonempty array of {diameter, flow, type} objects, left extruder first.");
  }
  return list.map((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`nozzles[${i}] must be an object with optional diameter, flow and type.`);
    }
    const unknown = Object.keys(entry).filter(key => !["diameter", "flow", "type"].includes(key));
    if (unknown.length) throw new Error(`nozzles[${i}] has unknown field(s) ${unknown.join(", ")}; use diameter, flow and type.`);
    const raw = entry as Record<string, unknown>;
    const nozzle: ExtruderNozzle = {};
    if (raw.diameter !== undefined && raw.diameter !== null && raw.diameter !== "") {
      const diameter = Number(raw.diameter);
      if (!Number.isFinite(diameter) || diameter <= 0) throw new Error(`nozzles[${i}].diameter must be a positive number of millimetres.`);
      nozzle.diameter = diameter;
    }
    if (raw.flow !== undefined && raw.flow !== null && raw.flow !== "") nozzle.flow = normalizeNozzleFlow(raw.flow);
    if (raw.type !== undefined && raw.type !== null && raw.type !== "") nozzle.type = normalizeNozzleMaterial(raw.type);
    return nozzle;
  });
}

/** The `filament_map` tool argument: Bambu Studio extruder number per filament slot (1 = left, 2 = right). */
export function parseFilamentMapArg(value: unknown): number[] | undefined {
  const list = parseListArg(value, "filament_map");
  if (!list) return undefined;
  if (list.length === 0) throw new Error("filament_map must list one extruder per filament slot.");
  return list.map((entry, i) => {
    const word = token(entry);
    if (word === "left") return 1;
    if (word === "right") return 2;
    const number = typeof entry === "number" ? entry : /^\d+$/.test(word) ? Number(word) : NaN;
    if (!Number.isInteger(number) || number < 1) {
      throw new Error(`filament_map[${i}] must be an extruder number (1 = left, 2 = right) or "left"/"right"; got ${JSON.stringify(entry)}.`);
    }
    return number;
  });
}

/** The `filament_sources` tool argument: "ams", "ams:<unit id>" or "external" per filament slot. */
export function parseFilamentSourcesArg(value: unknown): FilamentSource[] | undefined {
  const list = parseListArg(value, "filament_sources");
  if (!list) return undefined;
  if (list.length === 0) throw new Error("filament_sources must list one source per filament slot.");
  return list.map((entry, i) => {
    const text = String(entry ?? "").trim().toLowerCase();
    if (["external", "ext", "external spool", "spool"].includes(text)) return { kind: "external" } as const;
    const ams = /^ams(?:\s*[:#]?\s*(\d+))?$/.exec(text);
    if (ams) return ams[1] === undefined ? { kind: "ams" } as const : { kind: "ams", unit: Number(ams[1]) } as const;
    throw new Error(`filament_sources[${i}] must be "ams", "ams:<unit id>" or "external"; got ${JSON.stringify(entry)}.`);
  });
}

const FLOW_FROM_REPORT: Record<string, string> = {
  standard: "Standard", highflow: "High Flow", tpuhighflow: "TPU High Flow", e3dhighflow: "E3D High Flow",
};
const MATERIAL_FROM_REPORT: Record<string, string> = {
  stainlesssteel: "stainless_steel", hardenedsteel: "hardened_steel", tungstencarbide: "tungsten_carbide", brass: "brass",
};

/**
 * Read the mounted nozzles and filament feeds from a fresh printer report
 * (`status.raw`). Nozzles come from the safety parser (rack hotends, ids 16+,
 * are not mounted and are left out). Each AMS's `info` hex bits 8-11 name the
 * physical extruder it is bound to, 0xE meaning a filament track switch that
 * reaches both (Bambu Studio DevFilaSystemParser). On dual-nozzle printers
 * the external holder 254 feeds the deputy (left, id 1) nozzle and 255 the
 * main (right, id 0) one.
 */
export function extrudersFromReport(raw: Record<string, any>): ReportedExtruders {
  if (!raw || typeof raw !== "object") throw new Error("A printer report is required to read its nozzles.");
  const nozzles = reportedNozzles(raw).map(nozzle => ({
    physical: nozzle.index,
    diameter: nozzle.diameter,
    ...(nozzle.flow && FLOW_FROM_REPORT[nozzle.flow] ? { flow: FLOW_FROM_REPORT[nozzle.flow] } : {}),
    ...(nozzle.type && MATERIAL_FROM_REPORT[nozzle.type] ? { type: MATERIAL_FROM_REPORT[nozzle.type] } : {}),
  }));
  if (nozzles.length === 0) throw new Error("The printer report lists no mounted nozzles.");
  const ids = nozzles.map(nozzle => nozzle.physical);
  const single = ids.length === 1;

  const units = Array.isArray(raw.ams?.ams) ? raw.ams.ams : [];
  const ams = units.flatMap((unit: any) => {
    const id = Number(unit?.id);
    if (!Number.isInteger(id) || id < 0) return [];
    if (single) return [{ unit: id, physical: [ids[0]] }];
    const info = typeof unit?.info === "string" && /^[0-9a-f]+$/i.test(unit.info.trim()) ? parseInt(unit.info.trim(), 16) : undefined;
    if (info === undefined || !Number.isSafeInteger(info)) return [{ unit: id, physical: undefined }];
    const extruder = (info >> 8) & 0xf;
    if (extruder === 0xe) return [{ unit: id, physical: [...ids] }];
    return [{ unit: id, physical: ids.includes(extruder) ? [extruder] : undefined }];
  });

  const loaded = (slot: any) => typeof slot?.tray_type === "string" && slot.tray_type.trim().length > 0;
  const external: ReportedExtruders["external"] = [];
  const holders = Array.isArray(raw.vir_slot) ? raw.vir_slot : raw.vt_tray && typeof raw.vt_tray === "object" ? [raw.vt_tray] : [];
  for (const holder of holders) {
    const id = Number(holder?.id);
    const physical = single ? ids[0] : id === 254 ? 1 : id === 255 ? 0 : undefined;
    if (physical === undefined || !ids.includes(physical) || external.some(entry => entry.physical === physical)) continue;
    external.push({ physical, loaded: loaded(holder) });
  }
  return { nozzles, ams, external };
}

/**
 * The single machine-preset diameter for a slice. Bambu Studio has one
 * machine preset per diameter, so every extruder must share it.
 */
export function sliceNozzleDiameter(
  explicit: string | undefined,
  nozzles: ExtruderNozzle[] | undefined,
  reported: ReportedExtruders | undefined,
): string | undefined {
  const fromNozzles = (nozzles ?? []).map(nozzle => nozzle.diameter).filter((d): d is number => d !== undefined);
  // Explicit per-extruder diameters replace the report's; a partial list cannot be placed without the profile.
  const candidates = fromNozzles.length === (nozzles?.length ?? 0) && fromNozzles.length > 0
    ? fromNozzles
    : [...fromNozzles, ...(reported?.nozzles ?? []).map(nozzle => nozzle.diameter)];
  const distinct = [...new Set(candidates.map(d => Number(d.toFixed(3))))];
  if (distinct.length > 1) {
    throw new Error(
      `The nozzles have different diameters (${distinct.join(" mm, ")} mm). Bambu Studio has no machine preset that mixes nozzle diameters; ` +
      `fit matching nozzles or slice for one diameter.`
    );
  }
  const derived = distinct[0];
  if (explicit !== undefined && explicit !== "") {
    const value = Number(explicit);
    if (derived !== undefined && Math.abs(value - derived) > 0.0001) {
      throw new Error(`nozzle_diameter ${explicit} does not match the nozzles' ${derived} mm.`);
    }
    return String(explicit);
  }
  return derived === undefined ? undefined : String(derived);
}
