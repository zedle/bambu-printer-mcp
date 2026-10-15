export function normalizeBridgeAmsTrayValue(value: unknown, label: string): number {
  let numeric: number;
  if (typeof value === "number") {
    numeric = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    numeric = Number(value);
  } else {
    throw new Error(`${label} must be an integer tray index; got ${JSON.stringify(value)}`);
  }

  // Absolute trays: 0-15 (AMS units 0-3, four slots each), 128-135 (AMS-HT units, one slot each), and the
  // external holders 254 (left/deputy) and 255 (right/main, or the only holder on single-nozzle printers).
  if (
    !Number.isInteger(numeric) ||
    numeric < -1 ||
    (numeric > 15 && numeric < 128) ||
    (numeric > 135 && numeric < 254) ||
    numeric > 255
  ) {
    throw new Error(
      `${label} must be an integer in [-1, 15] (absolute tray), 128-135 (AMS-HT) or 254/255 (external spool); got ${JSON.stringify(value)}`
    );
  }

  return numeric;
}

function isNumericMappingKey(key: string): boolean {
  const numeric = Number(key);
  return Number.isInteger(numeric) && numeric >= 0;
}

export function normalizeAmsMappingObject(mapping: Record<string, unknown>, label = "ams_mapping"): number[] {
  return Object.entries(mapping)
    .sort(([leftKey], [rightKey]) => {
      const leftNumeric = isNumericMappingKey(leftKey);
      const rightNumeric = isNumericMappingKey(rightKey);
      if (leftNumeric && rightNumeric) return Number(leftKey) - Number(rightKey);
      if (leftNumeric) return -1;
      if (rightNumeric) return 1;
      return 0;
    })
    .map(([key, value]) => normalizeBridgeAmsTrayValue(value, `${label}[${key}]`));
}

export function hasAmsMappingInput(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
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
export function studioTrayMapping(mapping: number[], singleExtruder: boolean): { v0: number[]; v1: { ams_id: number; slot_id: number }[]; trays: number[] } {
  const trays = mapping.map(tray => (singleExtruder && (tray === 254 || tray === 255) ? 255 : tray));
  const v0 = trays.map(tray => (tray === 254 || tray === 255 ? -1 : tray));
  const v1 = trays.map(tray => {
    if (tray < 0) return { ams_id: 255, slot_id: 255 };
    if (tray === 254 || tray === 255) return { ams_id: tray, slot_id: 0 };
    if (tray >= 128) return { ams_id: tray, slot_id: 0 };
    return { ams_id: Math.floor(tray / 4), slot_id: tray % 4 };
  });
  return { v0, v1, trays };
}
