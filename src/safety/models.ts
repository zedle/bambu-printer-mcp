/**
 * Per-model printer facts that Bambu Studio keeps in its machine profiles and resources/printers/*.json.
 * The network plug-in has no per-model tables, so everything model-specific is decided by the caller (here).
 * Sources: BambuStudio resources/profiles/BBL/machine/fdm_bbl_3dp_002_common.json (physical_extruder_map),
 * DeviceCore/DevDefs.h (VIRTUAL_TRAY_MAIN_ID 255, VIRTUAL_TRAY_DEPUTY_ID 254, MAIN_EXTRUDER_ID 0,
 * DEPUTY_EXTRUDER_ID 1), resources/printers/*.json (printer_type, ftp_folder, calibration support).
 */

/** Printers with two extruders. Studio's physical ids: 0 = main (right), 1 = deputy (left). */
export const DUAL_EXTRUDER_MODELS: ReadonlySet<string> = new Set(["h2d", "h2dpro", "h2c", "x2d"]);
/** Printers whose right (main) extruder carries an induction hotend rack (nozzle ids 16-21). */
export const NOZZLE_RACK_MODELS: ReadonlySet<string> = new Set(["h2c"]);

export const MAIN_EXTRUDER_ID = 0;
export const DEPUTY_EXTRUDER_ID = 1;
export const EXTERNAL_MAIN_ID = 255;
export const EXTERNAL_DEPUTY_ID = 254;

export function extruderCount(model: string): number {
  return DUAL_EXTRUDER_MODELS.has(model) ? 2 : 1;
}

/**
 * Logical extruder (the sliced file's order, left first) to the printer's physical extruder id. Every dual-extruder
 * Bambu profile inherits physical_extruder_map ["1","0"] from fdm_bbl_3dp_002_common.json: logical 0 (left) is the
 * deputy (id 1), logical 1 (right) the main (id 0). A file that declares the map wins when it is well formed.
 */
export function physicalExtruderMap(model: string, declared?: number[]): number[] {
  const count = extruderCount(model);
  const fallback = count === 2 ? [DEPUTY_EXTRUDER_ID, MAIN_EXTRUDER_ID] : [MAIN_EXTRUDER_ID];
  if (!declared) return fallback;
  if (declared.length !== count || new Set(declared).size !== count || declared.some(id => !Number.isInteger(id) || id < 0 || id >= count)) {
    throw new Error(`Sliced physical_extruder_map ${JSON.stringify(declared)} does not describe this ${model}'s ${count} extruder(s).`);
  }
  return declared;
}

/**
 * External spool holders that can feed a nozzle on each model, by holder id. Single-extruder printers have one holder:
 * new firmware reports it as vir_slot 255 (H2S, P2S, X1 on current firmware), older firmware as vt_tray (Studio
 * relabels it 255); the MCP's historical 254 is accepted as an alias for that one holder. H2D, H2D Pro and X2D have
 * one holder per extruder (254 left, 255 right). The H2C's right extruder (with the hotend rack) is fed by the AMS
 * only: its 255 holder is reported but can't feed a print (verified on an H2C), so only 254 is real there.
 */
export function externalHolders(model: string): number[] {
  if (model === "h2c") return [EXTERNAL_DEPUTY_ID];
  if (DUAL_EXTRUDER_MODELS.has(model)) return [EXTERNAL_DEPUTY_ID, EXTERNAL_MAIN_ID];
  return [EXTERNAL_MAIN_ID];
}

export function isExternalTray(tray: number): boolean {
  return tray === EXTERNAL_DEPUTY_ID || tray === EXTERNAL_MAIN_ID;
}

/** The external holder that feeds a physical extruder (Studio DevMapping: 254 deputy/left, 255 main/right). */
export function externalHolderForExtruder(model: string, physicalExtruder: number): number {
  if (!DUAL_EXTRUDER_MODELS.has(model)) return EXTERNAL_MAIN_ID;
  const holder = physicalExtruder === DEPUTY_EXTRUDER_ID ? EXTERNAL_DEPUTY_ID : EXTERNAL_MAIN_ID;
  if (!externalHolders(model).includes(holder)) {
    throw new Error(`The ${model.toUpperCase()} ${physicalExtruder === MAIN_EXTRUDER_ID ? "right" : "left"} nozzle has no external spool holder; map that filament to an AMS slot.`);
  }
  return holder;
}

/**
 * External-spool mapping for a job without AMS: each used filament goes to the holder of its extruder. Dual-extruder
 * files say which extruder each filament uses (filament_map, 1 = left, 2 = right; Studio's default is 1).
 * Single-extruder printers keep the historical 254, which every transport accepts for their one holder.
 */
export function externalSpoolMapping(model: string, job: { materials: string[]; usedFilamentPositions: number[]; filamentMap?: number[]; physicalExtruderMap?: number[]; filamentNozzleIndices?: number[] }): number[] {
  const mapping = Array<number>(job.materials.length).fill(-1);
  const dual = DUAL_EXTRUDER_MODELS.has(model);
  const map = physicalExtruderMap(model, job.physicalExtruderMap);
  for (const position of job.usedFilamentPositions) {
    if (!dual) { mapping[position] = EXTERNAL_DEPUTY_ID; continue; }
    // The plate headers' composed nozzle binding, else the sliced filament_map through physical_extruder_map.
    const logical = job.filamentMap?.[position];
    const nozzle = job.filamentNozzleIndices?.[position] ?? (logical !== undefined ? map[logical - 1] : undefined);
    if (nozzle !== undefined) { mapping[position] = externalHolderForExtruder(model, nozzle); continue; }
    // Without a binding only a printer with one usable holder (the H2C's 254) can be chosen for.
    const holders = externalHolders(model);
    if (holders.length !== 1) {
      throw new Error(`The external spool for filament ${position + 1} is ambiguous on the ${model.toUpperCase()}: the job has no filament_map and physical_extruder_map binding to choose holder 254 (left) or 255 (right). Pass ams_slots or re-slice with a filament map.`);
    }
    mapping[position] = holders[0];
  }
  return mapping;
}
/** Studio printer_type codes (resources/printers/<code>.json) and the serial prefixes they use. */
export const PRINTER_TYPES: Readonly<Record<string, string>> = {
  O1C: "H2C", O1C2: "H2C", O1D: "H2D", O1E: "H2D Pro", O1S: "H2S", N6: "X2D", N7: "P2S",
  N2S: "A1", N1: "A1 Mini", A1M: "A1 Mini", C11: "P1P", C12: "P1S", C13: "X1E",
  "BL-P001": "X1C", "BL-P002": "X1", "3DPRINTER-X1-CARBON": "X1C", "3DPRINTER-X1": "X1",
};

/** Studio's printer_type code with an optional hardware revision suffix (e.g. O1D-V2, N7-V2). */
export function printerTypeModel(value: string): string | undefined {
  const code = value.trim().toUpperCase();
  return PRINTER_TYPES[code] ?? PRINTER_TYPES[code.replace(/-V\d+$/, "")];
}

/** Studio's DevPrinterConfigUtil::get_ftp_folder: "sdcard/" on P1P, P1S, A1, A1 mini (and A2L), empty elsewhere. */
export function ftpFolder(model: string): string {
  return ["p1p", "p1s", "a1", "a1mini"].includes(model) ? "sdcard/" : "";
}
