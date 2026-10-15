type Report = Record<string, any>;
export interface PrintStartGateOptions {
    model: string;
    /** Project filament count (Studio counts its filament presets). */
    filamentCount?: number;
    /** AMS trays the job is mapped to (unit*4+slot, AMS-HT unit ids 128-135, external 254/255). */
    trays?: number[];
    timelapse?: boolean;
    /** The highest chamber target the job sets (M141/M191), as the inspection found it. */
    maxChamberTemperature?: number;
}
/**
 * DevStorage: 0 no card, 1 normal, 2 abnormal, 3 read-only. New-protocol printers report it in aux bits 12-13,
 * others in home_flag bits 8-9 (parse_home_flag), else the `sdcard` flag (DevStorage::ParseV1_0). Undefined when the
 * report says nothing about storage.
 */
export declare function sdCardState(raw: Report): number | undefined;
/**
 * Throw where Studio blocks a print on the printer's state, and return the warnings it lists. Only for print starts:
 * uploads, heating and resume have their own rules.
 */
export declare function printStartGates(raw: Report, options: PrintStartGateOptions): string[];
export {};
