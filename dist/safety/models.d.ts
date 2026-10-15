/**
 * Per-model printer facts that Bambu Studio keeps in its machine profiles and resources/printers/*.json.
 * The network plug-in has no per-model tables, so everything model-specific is decided by the caller (here).
 * Sources: BambuStudio resources/profiles/BBL/machine/fdm_bbl_3dp_002_common.json (physical_extruder_map),
 * DeviceCore/DevDefs.h (VIRTUAL_TRAY_MAIN_ID 255, VIRTUAL_TRAY_DEPUTY_ID 254, MAIN_EXTRUDER_ID 0,
 * DEPUTY_EXTRUDER_ID 1), resources/printers/*.json (printer_type, ftp_folder, calibration support).
 */
/** Printers with two extruders. Studio's physical ids: 0 = main (right), 1 = deputy (left). */
export declare const DUAL_EXTRUDER_MODELS: ReadonlySet<string>;
/** Printers whose right (main) extruder carries an induction hotend rack (nozzle ids 16-21). */
export declare const NOZZLE_RACK_MODELS: ReadonlySet<string>;
export declare const MAIN_EXTRUDER_ID = 0;
export declare const DEPUTY_EXTRUDER_ID = 1;
export declare const EXTERNAL_MAIN_ID = 255;
export declare const EXTERNAL_DEPUTY_ID = 254;
export declare function extruderCount(model: string): number;
/**
 * Logical extruder (the sliced file's order, left first) to the printer's physical extruder id. Every dual-extruder
 * Bambu profile inherits physical_extruder_map ["1","0"] from fdm_bbl_3dp_002_common.json: logical 0 (left) is the
 * deputy (id 1), logical 1 (right) the main (id 0). A file that declares the map wins when it is well formed.
 */
export declare function physicalExtruderMap(model: string, declared?: number[]): number[];
/**
 * External spool holders that can feed a nozzle on each model, by holder id. Single-extruder printers have one holder:
 * new firmware reports it as vir_slot 255 (H2S, P2S, X1 on current firmware), older firmware as vt_tray (Studio
 * relabels it 255); the MCP's historical 254 is accepted as an alias for that one holder. H2D, H2D Pro and X2D have
 * one holder per extruder (254 left, 255 right). The H2C's right extruder (with the hotend rack) is fed by the AMS
 * only: its 255 holder is reported but can't feed a print (verified on an H2C), so only 254 is real there.
 */
export declare function externalHolders(model: string): number[];
export declare function isExternalTray(tray: number): boolean;
/** The external holder that feeds a physical extruder (Studio DevMapping: 254 deputy/left, 255 main/right). */
export declare function externalHolderForExtruder(model: string, physicalExtruder: number): number;
/**
 * External-spool mapping for a job without AMS: each used filament goes to the holder of its extruder. Dual-extruder
 * files say which extruder each filament uses (filament_map, 1 = left, 2 = right; Studio's default is 1).
 * Single-extruder printers keep the historical 254, which every transport accepts for their one holder.
 */
export declare function externalSpoolMapping(model: string, job: {
    materials: string[];
    usedFilamentPositions: number[];
    filamentMap?: number[];
    physicalExtruderMap?: number[];
}): number[];
/** Studio printer_type codes (resources/printers/<code>.json) and the serial prefixes they use. */
export declare const PRINTER_TYPES: Readonly<Record<string, string>>;
/** Studio's printer_type code with an optional hardware revision suffix (e.g. O1D-V2, N7-V2). */
export declare function printerTypeModel(value: string): string | undefined;
/** Studio's DevPrinterConfigUtil::get_ftp_folder: "sdcard/" on P1P, P1S, A1, A1 mini (and A2L), empty elsewhere. */
export declare function ftpFolder(model: string): string;
