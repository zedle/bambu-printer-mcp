/**
 * Bambu Studio's filament prohibitions (resources/printers/filaments_blacklist.json, action "prohibition"), applied
 * like DevFilaBlacklist::check_filaments_in_blacklist before a print is sent. Warnings from that file are not ported.
 * Matching is case-insensitive: type is the filament type (tray_type, else the sliced filament_type), name the preset
 * name (filament_settings_id without " @..."), id the Bambu filament id (tray_info_idx or the file's filament_ids).
 */

/** Studio model_id (printer_type) per model. */
export const STUDIO_MODEL_IDS: Readonly<Record<string, string[]>> = {
  p1p: ["C11"], p1s: ["C12"], x1c: ["BL-P001"], x1: ["BL-P002"], x1e: ["C13"], a1: ["N2S"], a1mini: ["N1"],
  h2d: ["O1D"], h2dpro: ["O1E"], h2c: ["O1C", "O1C2"], h2s: ["O1S"], x2d: ["N6"], p2s: ["N7"],
};

interface Rule {
  type?: string; vendor?: "bambu lab"; nameSuffix?: string; slot?: "ams" | "ext"; modelIds?: string[]; nozzleFlows?: string[];
  nozzleDiameters?: number[]; whiteFilamentIds?: string[]; calibMode?: "auto_pa"; description: string;
}

const E3D_HF = "The current filament doesn't support the E3D high-flow nozzle and can't be used.";
const P1_X1C = ["C11", "C12", "BL-P001"];
const RULES: readonly Rule[] = [
  { type: "tpu", slot: "ams", description: "TPU is not supported by AMS." },
  { vendor: "bambu lab", type: "pet-cf", slot: "ams", description: "AMS does not support 'Bambu Lab PET-CF'." },
  { nameSuffix: "pa6-gf", nozzleFlows: ["high flow"], modelIds: P1_X1C, description: E3D_HF },
  { type: "pps-cf", nozzleFlows: ["high flow"], modelIds: P1_X1C, description: E3D_HF },
  { type: "pla-aero", nozzleFlows: ["high flow"], modelIds: P1_X1C, description: E3D_HF },
  { type: "asa-aero", nozzleFlows: ["high flow"], modelIds: P1_X1C, description: E3D_HF },
  { nameSuffix: "tpu 85a", nozzleFlows: ["high flow"], modelIds: P1_X1C, description: E3D_HF },
  { nameSuffix: "tpu 90a", nozzleFlows: ["high flow"], modelIds: P1_X1C, description: E3D_HF },
  { whiteFilamentIds: ["GFU04", "GFU03", "GFU01", "GFU00", "GFU99"], nozzleFlows: ["tpu high flow"], modelIds: ["O1D", "O1E"],
    description: "The current filament doesn't support the TPU high-flow nozzle and can't be used." },
  { type: "tpu", calibMode: "auto_pa", modelIds: ["O1D", "O1E"], description: "Auto dynamic flow calibration is not supported for TPU filament." },
  { nameSuffix: "bambu tpu 85a", nozzleFlows: ["standard", "high flow"], nozzleDiameters: [0.4], modelIds: ["O1D", "O1E"],
    description: "Bambu TPU 85A is not supported for printing with 0.4 mm Standard or High Flow nozzles." },
];

/** The MCP's flow tokens as Studio's GetNozzleFlowTypeString names them (the P1/X1 E3D hotend reports High Flow). */
const FLOW_NAMES: Record<string, string> = { standard: "standard", highflow: "high flow", e3dhighflow: "high flow", tpuhighflow: "tpu high flow" };

export interface FilamentCheck {
  model: string;
  external: boolean;
  type?: string;
  name?: string;
  filamentId?: string;
  nozzleFlow?: string;
  nozzleDiameter?: number;
  /** "auto_pa" when the job's flow calibration is automatic. */
  calibMode?: string;
}

/** The first Studio prohibition the filament hits, or undefined. */
export function filamentProhibition(check: FilamentCheck): string | undefined {
  const modelIds = STUDIO_MODEL_IDS[check.model] ?? [];
  const type = (check.type ?? "").trim().toLowerCase();
  const name = (check.name ?? "").trim().toLowerCase();
  const id = (check.filamentId ?? "").trim().toUpperCase();
  const flow = check.nozzleFlow === undefined ? undefined : FLOW_NAMES[check.nozzleFlow.toLowerCase().replace(/[\s_-]/g, "")];
  // Bambu-made filaments carry Bambu ids (GFx00-GFx97); GFx98/GFx99 are the generic profiles.
  const bambuVendor = /^GF[A-Z]\d\d$/.test(id) && !/9[89]$/.test(id) || name.startsWith("bambu ");
  for (const rule of RULES) {
    if (rule.modelIds && !rule.modelIds.some(modelId => modelIds.includes(modelId))) continue;
    if (rule.nozzleFlows && (flow === undefined || !rule.nozzleFlows.includes(flow))) continue;
    if (rule.nozzleDiameters && check.nozzleDiameter !== undefined && !rule.nozzleDiameters.some(value => Math.abs(value - check.nozzleDiameter!) < 1e-6)) continue;
    if (rule.vendor && !bambuVendor) continue;
    if (rule.calibMode && check.calibMode !== rule.calibMode) continue;
    if (rule.type && rule.type !== type) continue;
    if (rule.nameSuffix && !name.endsWith(rule.nameSuffix)) continue;
    if (rule.slot && (rule.slot === "ext") !== check.external) continue;
    if (rule.whiteFilamentIds && id && rule.whiteFilamentIds.includes(id)) continue;
    return rule.description;
  }
  return undefined;
}
