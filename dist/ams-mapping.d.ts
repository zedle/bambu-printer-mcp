export declare function normalizeBridgeAmsTrayValue(value: unknown, label: string): number;
export declare function normalizeAmsMappingObject(mapping: Record<string, unknown>, label?: string): number[];
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
