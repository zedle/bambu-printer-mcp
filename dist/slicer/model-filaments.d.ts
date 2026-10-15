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
export declare function paintStates(serialized: string): number[];
/** The highest filament slot (1-based) the model's objects, parts, layer ranges and paint use; 0 when none is named. */
export declare function highestModelFilamentSlot(zip: {
    file(name: string | RegExp): any;
}): Promise<number>;
