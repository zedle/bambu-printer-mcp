/**
 * The nozzle plan Bambu Studio writes next to a sliced plate: Metadata/slice_info.config (per plate, the nozzles the
 * job uses and the nozzle each filament prints with) and Metadata/filament_sequence.json (the order filaments change
 * in). Studio's print dialog builds the hotend-rack request (DevNozzleMappingCtrl::CtrlGetAutoNozzleMappingV0/V1) and
 * matches the job against the rack (SelectMachineDialog::CheckErrorExtruderNozzleWithSlicing) from the same data, its
 * nozzle group result (MultiNozzleUtils), which bbs_3mf.cpp serializes there.
 *
 * Example (Bambu Studio 02.08.02.61, H2C, both filaments on the right rack, one Standard and one High Flow hotend):
 *   <nozzle id="1" extruder_id="2" nozzle_diameter="0.4" volume_type="Standard"/>
 *   <nozzle id="4" extruder_id="2" nozzle_diameter="0.4" volume_type="High Flow"/>
 *   <filament id="1" ... group_id="1" nozzle_diameter="0.40" volume_type="Standard" .../>
 */
/** One nozzle the sliced job uses: Studio's logical nozzle (group) id, its extruder (1 = left), size and flow. */
export interface SlicedNozzle {
    id: number;
    extruder: number;
    diameter: number;
    flow: string;
}
export interface SliceNozzlePlan {
    /** The nozzles the plate uses (slice_info `<nozzle>`). */
    nozzles: SlicedNozzle[];
    /** Per filament position (0-based): the nozzle group it prints with (slice_info `<filament group_id>`). */
    filamentNozzles: (number | undefined)[];
    /** Studio's filament_change_sequence: 0-based filament positions in the order the plate changes to them. */
    filamentChangeSequence?: number[];
    /** enable_filament_dynamic_map: filaments may move between nozzles (filament track switch). */
    dynamicNozzleMap: boolean;
}
/** Studio's volume_type text (Standard, High Flow, TPU High Flow, E3D High Flow) as the inspector's flow token. */
export declare function sliceFlowToken(value: unknown): string | undefined;
/**
 * The plate's nozzle plan, or undefined when the file has no slice_info entry for it (a G-code-only export).
 * Malformed entries fail closed: they feed the rack checks.
 */
export declare function parseSliceNozzlePlan(sliceInfo: string | undefined, filamentSequence: string | undefined, plateIndex: number, filamentCount: number): SliceNozzlePlan | undefined;
