export function describeAmsTrayRange(_options = {}) {
    return "[-1, 15] (absolute tray), 128-135 (AMS-HT) or 254/255 (external spool)";
}
export function normalizeBridgeAmsTrayValue(value, label, options = {}) {
    let numeric;
    if (typeof value === "number") {
        numeric = value;
    }
    else if (typeof value === "string" && value.trim() !== "") {
        numeric = Number(value);
    }
    else {
        throw new Error(`${label} must be an integer tray index; got ${JSON.stringify(value)}`);
    }
    // Absolute trays: 0-15 (AMS units 0-3, four slots each), 128-135 (AMS-HT units, one slot each), and the
    // external holders 254 (left/deputy) and 255 (right/main, or the only holder on single-nozzle printers).
    if (!Number.isInteger(numeric) ||
        numeric < -1 ||
        (numeric > 15 && numeric < 128) ||
        (numeric > 135 && numeric < 254) ||
        numeric > 255) {
        throw new Error(`${label} must be an integer in ${describeAmsTrayRange(options)}; got ${JSON.stringify(value)}`);
    }
    return numeric;
}
function isNumericMappingKey(key) {
    const numeric = Number(key);
    return Number.isInteger(numeric) && numeric >= 0;
}
export function normalizeAmsMappingObject(mapping, label = "ams_mapping", options = {}) {
    return Object.entries(mapping)
        .sort(([leftKey], [rightKey]) => {
        const leftNumeric = isNumericMappingKey(leftKey);
        const rightNumeric = isNumericMappingKey(rightKey);
        if (leftNumeric && rightNumeric)
            return Number(leftKey) - Number(rightKey);
        if (leftNumeric)
            return -1;
        if (rightNumeric)
            return 1;
        return 0;
    })
        .map(([key, value]) => normalizeBridgeAmsTrayValue(value, `${label}[${key}]`, options));
}
export function hasAmsMappingInput(value) {
    if (Array.isArray(value))
        return value.length > 0;
    if (value && typeof value === "object")
        return Object.keys(value).length > 0;
    return value !== undefined && value !== null;
}
/**
 * Bambu Studio's encoding of a positional tray mapping (SelectMachine.cpp get_ams_mapping_result), the strings the
 * network plug-in forwards unchanged as the LAN project_file and cloud task's ams_mapping/ams_mapping2:
 * - v0: the absolute tray, with external holders (254/255) as -1 and unused filaments as -1;
 * - v1: {ams_id, slot_id}: AMS units 0-3 as {tray / 4, tray % 4}, an AMS-HT unit (one slot) as {unit, 0}, an
 *   external holder as {254|255, 0}, unused as {255, 255}.
 * Single-extruder printers have one external holder, which Studio calls 255 (it relabels a legacy vt_tray as 255),
 * so the MCP's 254 for it is encoded as 255 there.
 */
export function studioTrayMapping(mapping, singleExtruder) {
    const trays = mapping.map(tray => studioTray(tray, !singleExtruder));
    return { v0: trays.map(tray => bridgeAmsMappingValue(tray, !singleExtruder)), v1: trays.map(tray => bridgeAmsMapping2Entry(tray, !singleExtruder)), trays };
}
/** The tray id Studio uses: a single-nozzle printer's one external holder is 255. */
function studioTray(tray, dualNozzle) {
    return !dualNozzle && (tray === 254 || tray === 255) ? 255 : tray;
}
/** One v0 (flat ams_mapping) entry: external holders and unused filaments are -1. */
export function bridgeAmsMappingValue(value, dualNozzle = false) {
    const tray = studioTray(value, dualNozzle);
    return tray === 254 || tray === 255 ? -1 : tray;
}
/** One v1 (ams_mapping2) entry: {tray / 4, tray % 4}, an AMS-HT unit as {unit, 0}, a holder as {254|255, 0}, unused {255, 255}. */
export function bridgeAmsMapping2Entry(value, dualNozzle = false) {
    const tray = studioTray(value, dualNozzle);
    if (tray < 0)
        return { ams_id: 255, slot_id: 255 };
    if (tray === 254 || tray === 255 || tray >= 128)
        return { ams_id: tray, slot_id: 0 };
    return { ams_id: Math.floor(tray / 4), slot_id: tray % 4 };
}
/**
 * The external holder that feeds a physical nozzle (0 right/main: 255, 1 left/deputy: 254). Dual-nozzle printers need
 * the inspected nozzle binding; single-nozzle printers have one holder (the MCP's 254).
 */
export function externalTrayForNozzle(nozzle, dualNozzle = false) {
    if (!dualNozzle)
        return 254;
    if (nozzle === 0)
        return 255;
    if (nozzle === 1)
        return 254;
    throw new Error("External-spool printing requires inspected filament_map and physical_extruder_map nozzle bindings.");
}
