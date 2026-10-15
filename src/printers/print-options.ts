/**
 * Print-job options as Bambu Studio sends them (SelectMachine.cpp, PrintJob.cpp), shared by every print transport.
 */
import { DUAL_EXTRUDER_MODELS } from "../safety/models.js";

/**
 * Studio's bed_type_to_gcode_string (PrintConfig.hpp): the task_bed_type PrintJob always sends, taken from the sliced
 * plate. Accepts the MCP's tool values (textured_plate, engineering_plate, ...), Studio's own strings and the plate
 * names in sliced files (curr_bed_type, plate_N.json ids).
 */
export function studioBedType(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = value.trim().toLowerCase().replace(/[_-]/g, " ").replace(/\s+/g, " ");
  if (["textured plate", "textured pei plate", "pte"].includes(text)) return "textured_plate";
  if (["supertack plate", "cool plate supertack", "suprtack"].includes(text)) return "supertack_plate";
  if (["hot plate", "high temp plate", "high temperature plate", "smooth pei plate", "pei"].includes(text)) return "hot_plate";
  if (["engineering plate", "eng plate", "ep plate", "engineering", "pe"].includes(text)) return "eng_plate";
  if (["cool plate", "pc plate", "cool", "pc"].includes(text)) return "cool_plate";
  return undefined;
}

/** Plates each machine profile lists in not_support_bed_type (BambuStudio profiles/BBL/machine). */
const UNSUPPORTED_BEDS: Readonly<Record<string, readonly string[]>> = {
  h2d: ["cool_plate"], h2dpro: ["cool_plate"], h2s: ["cool_plate"], p2s: ["cool_plate"], x2d: ["cool_plate"],
  h2c: ["cool_plate", "hot_plate"], a1mini: ["cool_plate", "eng_plate"],
};

export function assertBedSupported(model: string, bedType: string | undefined): void {
  if (bedType && UNSUPPORTED_BEDS[model]?.includes(bedType)) {
    throw new Error(`The ${model.toUpperCase()} doesn't support the ${bedType.replace(/_/g, " ")} (Bambu Studio's not_support_bed_type); re-slice for a supported plate.`);
  }
}

export type CalibrationChoice = "auto" | "on" | "off";
/** Studio's option values: getValueInt() is 0 off, 1 on, 2 auto; the bool is getValue() == "on". */
const INT: Record<CalibrationChoice, number> = { off: 0, on: 1, auto: 2 };

// resources/printers/*.json print.support_bed_leveling (2 = auto), support_flow_calibration /
// support_auto_flow_calibration, support_nozzle_offset_calibration.
const AUTO_CAPABLE = new Set(["h2d", "h2dpro", "h2c", "h2s", "p2s", "x2d"]);
const FLOW_CALIBRATION = new Set(["x1", "x1c", "x1e", "a1", "a1mini", ...AUTO_CAPABLE]);
const NOZZLE_OFFSET_CALIBRATION = DUAL_EXTRUDER_MODELS;

export function calibrationChoice(value: unknown, label: string): CalibrationChoice | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === true || value === 1) return "on";
  if (value === false || value === 0) return "off";
  if (typeof value === "string" && ["auto", "on", "off"].includes(value.trim().toLowerCase())) return value.trim().toLowerCase() as CalibrationChoice;
  throw new Error(`${label} must be true, false, "on", "off" or "auto".`);
}

export interface StudioPrintOptions {
  bedLeveling: boolean; autoBedLeveling: number;
  flowCalibration: boolean; autoFlowCalibration: number;
  autoOffsetCalibration: number;
  vibrationCalibration: boolean; layerInspect: boolean;
}

/**
 * Studio's set_print_config(bed, bed_leveling == "on", flow_cali == "on", vibration false, timelapse, layer_inspect true,
 * ..., getValueInt(bed_leveling), getValueInt(flow_cali), getValueInt(nozzle_offset_cali)): each option defaults to
 * "auto" where the printer offers it, else "on"; nozzle-offset calibration is auto with two used nozzles and off with
 * one. Options a printer doesn't offer are sent off, and "auto" is "on" where only on/off exist. The bool and the int
 * always come from the same choice.
 */
export function studioPrintOptions(model: string, usedExtruders: number, requested: {
  bedLeveling?: unknown; flowCalibration?: unknown; nozzleOffsetCalibration?: unknown; vibrationCalibration?: unknown; layerInspect?: unknown;
} = {}, usedFilamentTypes: string[] = []): StudioPrintOptions {
  const auto = AUTO_CAPABLE.has(model);
  // Studio's blacklist prohibits automatic flow calibration with TPU on the H2D and H2D Pro (calib_mode auto_pa), so
  // a TPU job there defaults to off, and an explicit "auto" is refused.
  const tpuNoAutoFlow = ["h2d", "h2dpro"].includes(model) && usedFilamentTypes.some(type => type.trim().toUpperCase() === "TPU");
  if (tpuNoAutoFlow && calibrationChoice(requested.flowCalibration, "flow_calibration") === "auto") {
    throw new Error("Auto dynamic flow calibration is not supported for TPU filament (Bambu Studio's filament blacklist).");
  }
  const pick = (value: unknown, label: string, offered: boolean, fallback: CalibrationChoice): CalibrationChoice => {
    const choice = calibrationChoice(value, label);
    // Studio hides an option the printer doesn't offer; a request for it can't turn it on.
    if (!offered) return "off";
    // On printers without the automatic mode Studio offers on/off only.
    if (choice === "auto" && !auto) return "on";
    return choice ?? fallback;
  };
  const bed = pick(requested.bedLeveling, "bed_leveling", true, auto ? "auto" : "on");
  const flow = pick(requested.flowCalibration, "flow_calibration", FLOW_CALIBRATION.has(model), tpuNoAutoFlow ? "off" : auto ? "auto" : "on");
  const offset = pick(requested.nozzleOffsetCalibration, "nozzle_offset_calibration", NOZZLE_OFFSET_CALIBRATION.has(model), usedExtruders >= 2 ? "auto" : "off");
  const toggle = (value: unknown, label: string, fallback: boolean): boolean => {
    const choice = calibrationChoice(value, label);
    if (choice === "auto") throw new Error(`${label} is on or off.`);
    return choice === undefined ? fallback : choice === "on";
  };
  return {
    bedLeveling: bed === "on", autoBedLeveling: INT[bed],
    flowCalibration: flow === "on", autoFlowCalibration: INT[flow],
    autoOffsetCalibration: INT[offset],
    vibrationCalibration: toggle(requested.vibrationCalibration, "vibration_calibration", false),
    layerInspect: toggle(requested.layerInspect, "layer_inspect", true),
  };
}

/** The raw filament types of the plate's used filaments, for the per-material option rules. */
export function usedFilamentTypes(inspection: { usedFilamentPositions: number[]; materials: string[]; filamentTypes?: string[] }): string[] {
  return inspection.usedFilamentPositions.map(position => inspection.filamentTypes?.[position] ?? inspection.materials[position] ?? "");
}

/** Physical extruders the plate's used filaments run on (Studio _get_used_nozzle_idxes; filament_map defaults to 1). */
export function usedExtruderCount(model: string, inspection: { usedFilamentPositions: number[]; filamentMap?: number[] }): number {
  if (!DUAL_EXTRUDER_MODELS.has(model)) return 1;
  return new Set(inspection.usedFilamentPositions.map(position => inspection.filamentMap?.[position] ?? 1)).size;
}

/** Studio's get_nozzle_volume_type_cloud_string for the sliced nozzle_volume_type values. */
const CLOUD_FLOW: Record<string, string> = { standard: "standard_flow", high_flow: "high_flow", tpu_high_flow: "tpu_high_flow", e3d_high_flow: "e3d_high_flow", hybrid: "hybrid_flow" };

/**
 * Studio's build_nozzles_info, sent with two-nozzle jobs: one entry per sliced nozzle, left first, with the cloud task's
 * nozzle id (left 1, right 0), a null type, the sliced flow and diameter. Single-nozzle jobs send none.
 */
export function studioNozzlesInfo(inspection: { nozzleDiameters: number[]; nozzleFlows?: string[] }): string {
  if (inspection.nozzleDiameters.length !== 2) return "";
  return JSON.stringify(inspection.nozzleDiameters.map((diameter, index) => {
    const flow = inspection.nozzleFlows?.[index]?.trim().toLowerCase().replace(/[\s-]+/g, "_");
    return { id: index === 0 ? 1 : 0, type: null, ...(flow && CLOUD_FLOW[flow] ? { flowSize: CLOUD_FLOW[flow] } : {}), diameter };
  }));
}
