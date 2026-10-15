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
