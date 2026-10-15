/**
 * The filament slots a 3MF's model uses, for projects that carry no filament list of their own
 * (geometry exported by another tool, or a hand-built 3MF without Metadata/project_settings.config).
 *
 * Bambu Studio assigns filaments in Metadata/model_settings.config: `<metadata key="extruder" value="N"/>` on
 * objects, parts and layer-range modifiers (1-based slot numbers). Painted colour regions are per-triangle
 * `paint_color` (Bambu) or `slic3rpe:mmu_segmentation` (Prusa) attributes in the model files, each a
 * TriangleSelector bit tree whose leaf states are slot numbers (0 = the object's own filament).
 */

/** Leaf states of one serialized TriangleSelector tree (libslic3r TriangleSelector::deserialize). */
export function paintStates(serialized: string): number[] {
  const text = serialized.trim();
  const states: number[] = [];
  // Nibbles are read from the end of the string.
  let position = text.length - 1;
  const nibble = (): number => {
    if (position < 0) throw new Error("truncated paint data");
    const value = parseInt(text[position--], 16);
    if (Number.isNaN(value)) throw new Error("malformed paint data");
    return value;
  };
  let pending = 1;
  while (pending > 0 && position >= 0) {
    const code = nibble();
    const splitSides = code & 0b11;
    pending -= 1;
    if (splitSides) {
      // A split triangle has splitSides + 1 children; bits 2-3 name its special side.
      pending += splitSides + 1;
      continue;
    }
    let state = code >> 2;
    if (state === 3) {
      // An extended state: each following 0xF nibble adds 15, the first other one holds the rest, minus 3.
      let next = nibble();
      let fifteens = 0;
      while (next === 0xf) { fifteens++; next = nibble(); }
      state = next + 15 * fifteens + 3;
    }
    states.push(state);
  }
  return states;
}

/** The highest filament slot (1-based) the model's objects, parts, layer ranges and paint use; 0 when none is named. */
export async function highestModelFilamentSlot(zip: { file(name: string | RegExp): any }): Promise<number> {
  let highest = 0;
  const settings = zip.file("Metadata/model_settings.config");
  if (settings && !Array.isArray(settings)) {
    const text: string = await settings.async("string");
    for (const match of text.matchAll(/<metadata\s+key\s*=\s*"extruder"\s+value\s*=\s*"(\d+)"/g)) {
      highest = Math.max(highest, Number(match[1]));
    }
  }
  const models = zip.file(/^3D\/.*\.model$/i);
  for (const model of Array.isArray(models) ? models : []) {
    const text: string = await model.async("string");
    for (const match of text.matchAll(/\b(?:paint_color|slic3rpe:mmu_segmentation)\s*=\s*"([0-9A-Fa-f]+)"/g)) {
      for (const state of paintStates(match[1])) highest = Math.max(highest, state);
    }
  }
  return highest;
}
