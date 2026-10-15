/**
 * Studio's bed_type_to_gcode_string (PrintConfig.hpp): the task_bed_type PrintJob always sends, taken from the sliced
 * plate. Accepts the MCP's tool values (textured_plate, engineering_plate, ...), Studio's own strings and the plate
 * names in sliced files (curr_bed_type, plate_N.json ids).
 */
export declare function studioBedType(value: unknown): string | undefined;
export declare function assertBedSupported(model: string, bedType: string | undefined): void;
export type CalibrationChoice = "auto" | "on" | "off";
export declare function calibrationChoice(value: unknown, label: string): CalibrationChoice | undefined;
export interface StudioPrintOptions {
    bedLeveling: boolean;
    autoBedLeveling: number;
    flowCalibration: boolean;
    autoFlowCalibration: number;
    autoOffsetCalibration: number;
    vibrationCalibration: boolean;
    layerInspect: boolean;
}
/**
 * Studio's set_print_config(bed, bed_leveling == "on", flow_cali == "on", vibration false, timelapse, layer_inspect true,
 * ..., getValueInt(bed_leveling), getValueInt(flow_cali), getValueInt(nozzle_offset_cali)): each option defaults to
 * "auto" where the printer offers it, else "on"; nozzle-offset calibration is auto with two used nozzles and off with
 * one. Options a printer doesn't offer are sent off, and "auto" is "on" where only on/off exist. The bool and the int
 * always come from the same choice.
 */
export declare function studioPrintOptions(model: string, usedExtruders: number, requested?: {
    bedLeveling?: unknown;
    flowCalibration?: unknown;
    nozzleOffsetCalibration?: unknown;
    vibrationCalibration?: unknown;
    layerInspect?: unknown;
}, usedFilamentTypes?: string[]): StudioPrintOptions;
/** The raw filament types of the plate's used filaments, for the per-material option rules. */
export declare function usedFilamentTypes(inspection: {
    usedFilamentPositions: number[];
    materials: string[];
    filamentTypes?: string[];
}): string[];
/** Physical extruders the plate's used filaments run on (Studio _get_used_nozzle_idxes; filament_map defaults to 1). */
export declare function usedExtruderCount(model: string, inspection: {
    usedFilamentPositions: number[];
    filamentMap?: number[];
}): number;
/**
 * Studio's build_nozzles_info, sent with two-nozzle jobs: one entry per sliced nozzle, left first, with the cloud task's
 * nozzle id (left 1, right 0), a null type, the sliced flow and diameter. Single-nozzle jobs send none.
 */
export declare function studioNozzlesInfo(inspection: {
    nozzleDiameters: number[];
    nozzleFlows?: string[];
}): string;
