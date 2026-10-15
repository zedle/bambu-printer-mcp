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
/** Whether the printer swaps right-side hotends from a rack: its report's `fun` bit 60, on a rack model. */
export declare function nozzleRackSupported(raw: Record<string, any> | undefined, model: string): boolean;
/**
 * Studio requests a mapping when the rack is supported and the job prints on the rack extruder (V0), or always with a
 * dynamic filament map (V1). Returns the version to ask for, or undefined when no mapping is needed.
 */
export declare function nozzleMappingVersion(raw: Record<string, any> | undefined, job: NozzleMappingJob): 0 | 1 | undefined;
/**
 * Build `get_auto_nozzle_mapping`. `amsMapping` is the checked positional tray mapping (one tray index per
 * filament position); `calibration` the job's flow-calibration choice (0 off, 1 on, 2 auto) and `paValue` its
 * extrude_cali_manual_mode (0 = the printer's own pressure advance, Studio's default).
 */
export declare function buildAutoNozzleMappingRequest(raw: Record<string, any>, job: NozzleMappingJob, amsMapping: number[], options: {
    version: 0 | 1;
    sequenceId: string;
    calibration: number;
    paValue: number;
}): {
    print: Record<string, unknown>;
};
/** The reply to the request numbered `sequenceId` in a printer message (an object or its JSON), if this is it. */
export declare function matchAutoNozzleMappingReply(message: unknown, sequenceId: string): AutoNozzleMappingReply | undefined;
export interface CheckedNozzleMapping {
    /** The reply's table, sent as the job's nozzle_mapping. */
    mapping: number[];
    version: 0 | 1;
    /** Per used filament (V0) or nozzle group (V1): Studio's label, L, R or R<n> for rack place n. */
    assignments: {
        filament?: number;
        nozzleGroup?: number;
        hotend: string;
    }[];
    warnings: string[];
}
/**
 * Check the printer's answer the way Studio's print dialog does (CheckErrorSyncNozzleMappingResultV0/V1): "failed"
 * (the request didn't reach the mapping) and "fail" (the printer couldn't build it) refuse the job, as does an empty
 * table. Every filament the job prints on the rack must also be mapped to a hotend that is there and matches the
 * filament's sliced nozzle (diameter and flow).
 */
export declare function checkAutoNozzleMappingReply(reply: AutoNozzleMappingReply, raw: Record<string, any>, job: NozzleMappingJob, version: 0 | 1): CheckedNozzleMapping;
/** How long to wait for the printer's mapping (BAMBU_NOZZLE_MAPPING_MS, default 15 s, at most 60 s). */
export declare function nozzleMappingWaitMs(): number;
/** A transport that sends one printer command and resolves with the first message `match` accepts, or undefined. */
export type PrinterQuery = (message: {
    print: Record<string, unknown>;
}, match: (message: unknown) => AutoNozzleMappingReply | undefined, waitMs: number) => Promise<AutoNozzleMappingReply | undefined>;
/**
 * Ask the printer for the job's hotend mapping when it needs one. Undefined when it doesn't (no rack, or nothing
 * prints on the rack extruder). No answer within the wait is reported, not fatal: the printer then picks the hotends
 * itself, as it did for jobs sent without a mapping; a refusal or a mapping that contradicts the job throws.
 */
export declare function requestNozzleMapping(raw: Record<string, any>, job: NozzleMappingJob, amsMapping: number[], options: {
    sequenceId: string;
    calibration: number;
    paValue: number;
    query: PrinterQuery;
    waitMs?: number;
}): Promise<{
    checked?: CheckedNozzleMapping;
    warning?: string;
} | undefined>;
