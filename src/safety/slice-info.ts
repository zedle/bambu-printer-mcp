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
export interface SlicedNozzle { id: number; extruder: number; diameter: number; flow: string }

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

const VOLUME_FLOW: Record<string, string> = {
  standard: "standard", highflow: "high_flow", tpuhighflow: "tpu_high_flow", tpuflow: "tpu_high_flow", e3dhighflow: "e3d_high_flow",
};
/** Studio's volume_type text (Standard, High Flow, TPU High Flow, E3D High Flow) as the inspector's flow token. */
export function sliceFlowToken(value: unknown): string | undefined {
  return VOLUME_FLOW[String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "")];
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([A-Za-z_][\w-]*)\s*=\s*"([^"]*)"/g)) result[match[1]] = match[2];
  return result;
}

const fail = (message: string): never => { throw new Error(`Print safety: ${message}`); };

/**
 * The plate's nozzle plan, or undefined when the file has no slice_info entry for it (a G-code-only export).
 * Malformed entries fail closed: they feed the rack checks.
 */
export function parseSliceNozzlePlan(sliceInfo: string | undefined, filamentSequence: string | undefined, plateIndex: number, filamentCount: number): SliceNozzlePlan | undefined {
  if (!sliceInfo) return undefined;
  const plates = [...sliceInfo.matchAll(/<plate>([\s\S]*?)<\/plate>/g)].map(match => match[1]);
  const plate = plates.find(body => {
    const index = /<metadata\s+key="index"\s+value="(\d+)"/.exec(body);
    return index && Number(index[1]) === plateIndex + 1;
  });
  if (!plate) return undefined;
  const nozzles: SlicedNozzle[] = [];
  for (const match of plate.matchAll(/<nozzle\b([^>]*)\/?>/g)) {
    const a = attributes(match[1]);
    const id = Number(a.id), extruder = Number(a.extruder_id), diameter = Number(a.nozzle_diameter);
    const flow = sliceFlowToken(a.volume_type);
    if (!Number.isInteger(id) || id < 0 || !Number.isInteger(extruder) || extruder < 1 || !Number.isFinite(diameter) || diameter <= 0 || !flow) {
      return fail("malformed slice_info nozzle metadata");
    }
    if (nozzles.some(nozzle => nozzle.id === id)) return fail("ambiguous slice_info nozzle metadata");
    nozzles.push({ id, extruder, diameter, flow });
  }
  const filamentNozzles: (number | undefined)[] = Array(filamentCount).fill(undefined);
  for (const match of plate.matchAll(/<filament\b([^>]*)\/?>/g)) {
    const a = attributes(match[1]);
    const position = Number(a.id) - 1;
    if (!Number.isInteger(position) || position < 0 || position >= filamentCount) return fail("slice_info names a filament the project does not declare");
    if (a.group_id === undefined || a.group_id === "") continue;
    const group = Number(a.group_id);
    if (!Number.isInteger(group) || group < 0) return fail("malformed slice_info filament nozzle group");
    const nozzle = nozzles.find(value => value.id === group);
    // A filament's own diameter and flow must be its nozzle's.
    if (nozzle && ((a.nozzle_diameter !== undefined && Math.abs(Number(a.nozzle_diameter) - nozzle.diameter) > 1e-6) ||
        (a.volume_type !== undefined && sliceFlowToken(a.volume_type) !== nozzle.flow))) {
      return fail("slice_info filament nozzle metadata contradicts its nozzle");
    }
    filamentNozzles[position] = group;
  }
  const dynamic = /<metadata\s+key="enable_filament_dynamic_map"\s+value="true"/i.test(plate);
  let filamentChangeSequence: number[] | undefined;
  if (filamentSequence) {
    let parsed: any;
    try { parsed = JSON.parse(filamentSequence); } catch { return fail("malformed filament_sequence.json"); }
    const entry = parsed?.[`plate_${plateIndex + 1}`];
    const sequence = entry?.filament_sequence ?? entry?.sequence;
    if (sequence !== undefined) {
      // Stored 1-based (bbs_3mf.cpp _extract_filament_sequence_from_archive).
      if (!Array.isArray(sequence) || sequence.some(value => !Number.isInteger(value) || value < 1 || value > filamentCount)) {
        return fail("malformed filament_sequence.json sequence");
      }
      filamentChangeSequence = sequence.map((value: number) => value - 1);
    }
  }
  return { nozzles, filamentNozzles, ...(filamentChangeSequence ? { filamentChangeSequence } : {}), dynamicNozzleMap: dynamic };
}
