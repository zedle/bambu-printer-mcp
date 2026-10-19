/**
 * Tray-value options. `dualNozzle` names a printer with one external holder per nozzle (254 left/deputy, 255
 * right/main, Bambu Studio's VIRTUAL_TRAY_DEPUTY_ID / VIRTUAL_TRAY_MAIN_ID). Single-nozzle printers have one holder,
 * which current firmware reports as 255 and the MCP has historically called 254, so both values are accepted there too.
 */
export interface AmsTrayValueOptions {
    dualNozzle?: boolean;
}
export declare function describeAmsTrayRange(_options?: AmsTrayValueOptions): string;
export declare function normalizeBridgeAmsTrayValue(value: unknown, label: string, options?: AmsTrayValueOptions): number;
export declare function normalizeAmsMappingObject(mapping: Record<string, unknown>, label?: string, options?: AmsTrayValueOptions): number[];
export declare function hasAmsMappingInput(value: unknown): boolean;
/**
 * Bambu Studio's encoding of a positional tray mapping (SelectMachine.cpp get_ams_mapping_result), the strings the
 * network plug-in forwards unchanged as the LAN project_file and cloud task's ams_mapping/ams_mapping2:
 * - v0: the absolute tray, with external holders (254/255) as -1 and unused filaments as -1;
 * - v1: {ams_id, slot_id}: AMS units 0-3 as {tray / 4, tray % 4}, an AMS-HT unit (one slot) as {unit, 0}, an
 *   external holder as {254|255, 0}, unused as {255, 255}.
 * Single-extruder printers have one external holder, which Studio calls 255 (it relabels a legacy vt_tray as 255),
 * so the MCP's 254 for it is encoded as 255 there.
 */
export declare function studioTrayMapping(mapping: number[], singleExtruder: boolean): {
    v0: number[];
    v1: {
        ams_id: number;
        slot_id: number;
    }[];
    trays: number[];
};
/** One v0 (flat ams_mapping) entry: external holders and unused filaments are -1. */
export declare function bridgeAmsMappingValue(value: number, dualNozzle?: boolean): number;
/** One v1 (ams_mapping2) entry: {tray / 4, tray % 4}, an AMS-HT unit as {unit, 0}, a holder as {254|255, 0}, unused {255, 255}. */
export declare function bridgeAmsMapping2Entry(value: number, dualNozzle?: boolean): {
    ams_id: number;
    slot_id: number;
};
/**
 * The external holder that feeds a physical nozzle (0 right/main: 255, 1 left/deputy: 254). Dual-nozzle printers need
 * the inspected nozzle binding; single-nozzle printers have one holder (the MCP's 254).
 */
export declare function externalTrayForNozzle(nozzle: number | undefined, dualNozzle?: boolean): number;
