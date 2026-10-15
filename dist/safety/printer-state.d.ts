import { BambuClient } from "bambu-node";
/** The model a serial prefix belongs to (Studio's sn_prefix). Identity evidence only together with a fresh report. */
export declare function serialModel(serial: string): string | undefined;
/**
 * A fresh report for a safety check: the printer's state restored the way Bambu Studio does it (printer-report.ts),
 * from a full report at most one full-push interval (3 s, Studio's REQUEST_PUSH_MIN_TIME) older than this request,
 * with at least one push merged after the request. Studio sends at most one full-push request per 3 s; a request
 * inside that window waits for the printer's next push, and only asks again once the window has passed. Never
 * read printer.data here: bambu-node's cache is display state.
 */
export declare function readFreshPrinterStatus(printer: BambuClient, serial: string, timeoutMs?: number): Promise<any>;
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
export interface ReportedNozzle {
    index: number;
    diameter: number;
    type?: string;
    flow?: string;
    stat?: number;
}
interface ReportedFilament {
    position: number;
    material: string;
    trayIndex: number;
    nozzleMin?: number;
    nozzleMax?: number;
}
export interface ValidatedPrinterState {
    model: string;
    reportedNozzles: ReportedNozzle[];
    filaments: ReportedFilament[];
    hmsWarnings: string[];
}
/** Mounted nozzles (ids 0-15) by firmware id; with rack, the H2C hotend-rack nozzles (ids 16-31) instead. */
export declare function reportedNozzles(raw: Record<string, any>, rack?: boolean): ReportedNozzle[];
/** Verifies reported configuration, not a physical nozzle/spool inspection. */
export declare function validatePrinterState(status: any, requirements: PrinterStateRequirements): ValidatedPrinterState;
/**
 * Manual nozzle heating cannot remap filament slots: validate the material already at the nozzle. Dual-nozzle printers
 * need the nozzle (extruder 0 right/main, 1 left/deputy); its loaded tray comes from device.extruder.info[].snow
 * (AMS id << 8 | slot; 0xFFFF none), as Studio's ExtderSystemParser reads it.
 */
export declare function manualHeatingRequirements(status: any, model: string, nozzleDiameter: number, material: string, extruder?: number): PrinterStateRequirements;
export {};
