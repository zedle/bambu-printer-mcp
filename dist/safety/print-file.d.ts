export interface PrintFileInspection {
    model: string;
    nozzleDiameters: number[];
    materials: string[];
    usedFilamentPositions: number[];
    plateInternalPath?: string;
    sha256: string;
    maxNozzleTemperature: number;
    maxBedTemperature: number;
    maxChamberTemperature: number;
    bedType?: string;
    selectsAms: boolean;
    nozzleTypes?: string[];
    nozzleFlows?: string[];
    /** Per filament, from the plate header: physical extruder (1 = left, 2 = right on dual-nozzle printers). */
    filamentMap?: number[];
    /** Logical extruder (left first) to the printer's physical extruder id, from the project's physical_extruder_map. */
    physicalExtruderMap?: number[];
    /** Per filament, from the plate header: Bambu filament ids (e.g. GFL99) and #RRGGBB colours. */
    filamentIds?: string[];
    filamentColours?: string[];
    /** Per filament, from the plate header: the raw filament_type (e.g. PLA-CF; materials holds the base family). */
    filamentTypes?: string[];
}
/** Inspect the exact selected plate. This does not simulate firmware or arbitrary motion:
 * only declared object bounds are checked, never purge/homing/wipe travel coordinates.
 * It also cannot authenticate self-declared metadata or the physical spool/nozzle.
 */
export declare function inspectPrintFile(filePath: string, options: {
    model: string;
    nozzleDiameters?: number[];
    plateIndex?: number;
    bedType?: string;
}): Promise<PrintFileInspection>;
