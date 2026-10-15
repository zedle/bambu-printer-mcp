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
/** Bambu Studio's NozzleVolumeType names. */
export declare const NOZZLE_FLOWS: readonly ["Standard", "High Flow", "TPU High Flow", "E3D High Flow"];
/** Bambu Studio's nozzle_type names (hotend material). */
export declare const NOZZLE_MATERIALS: readonly ["stainless_steel", "hardened_steel", "tungsten_carbide", "brass"];
/** One extruder's nozzle. Missing fields keep the printer report or the machine profile's value. */
export interface ExtruderNozzle {
    diameter?: number;
    /** One of NOZZLE_FLOWS. */
    flow?: string;
    /** One of NOZZLE_MATERIALS. */
    type?: string;
}
/** Where a filament slot is loaded from. `unit` selects one AMS unit by its reported id. */
export type FilamentSource = {
    kind: "ams";
    unit?: number;
} | {
    kind: "external";
};
/** A printer report, by firmware (physical) nozzle id. */
export interface ReportedExtruders {
    nozzles: {
        physical: number;
        diameter: number;
        flow?: string;
        type?: string;
    }[];
    /** Physical extruders each AMS unit feeds; undefined when the report doesn't say. */
    ams: {
        unit: number;
        physical: number[] | undefined;
    }[];
    /** External spool holders, by the physical extruder they feed. */
    external: {
        physical: number;
        loaded: boolean;
    }[];
}
export declare function normalizeNozzleFlow(value: unknown): string;
export declare function normalizeNozzleMaterial(value: unknown): string;
/** The `nozzles` tool argument: one object per extruder, left first. */
export declare function parseExtruderNozzlesArg(value: unknown): ExtruderNozzle[] | undefined;
/** The `filament_map` tool argument: Bambu Studio extruder number per filament slot (1 = left, 2 = right). */
export declare function parseFilamentMapArg(value: unknown): number[] | undefined;
/** The `filament_sources` tool argument: "ams", "ams:<unit id>" or "external" per filament slot. */
export declare function parseFilamentSourcesArg(value: unknown): FilamentSource[] | undefined;
/**
 * Read the mounted nozzles and filament feeds from a fresh printer report
 * (`status.raw`). Nozzles come from the safety parser (rack hotends, ids 16+,
 * are not mounted and are left out). Each AMS's `info` hex bits 8-11 name the
 * physical extruder it is bound to, 0xE meaning a filament track switch that
 * reaches both (Bambu Studio DevFilaSystemParser). On dual-nozzle printers
 * the external holder 254 feeds the deputy (left, id 1) nozzle and 255 the
 * main (right, id 0) one.
 */
export declare function extrudersFromReport(raw: Record<string, any>): ReportedExtruders;
/**
 * The single machine-preset diameter for a slice. Bambu Studio has one
 * machine preset per diameter, so every extruder must share it.
 */
export declare function sliceNozzleDiameter(explicit: string | undefined, nozzles: ExtruderNozzle[] | undefined, reported: ReportedExtruders | undefined): string | undefined;
