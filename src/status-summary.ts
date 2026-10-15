/**
 * The parts of a printer report an agent needs to decide what to do next, without the full report
 * (~40k tokens on an H2C, most of it module lists and fan/airduct internals). `get_printer_status`
 * returns this as `details`; `include_raw: true` adds the report itself.
 */

const hex8 = (value: unknown) => (Number(value) >>> 0).toString(16).toUpperCase().padStart(8, "0");

/** One HMS entry ({attr, code} in the report) as Bambu's AAAA-AAAA-CCCC-CCCC form. */
export function hmsCode(entry: { attr?: unknown; code?: unknown }): string {
  const text = hex8(entry.attr) + hex8(entry.code);
  return text.match(/.{4}/g)!.join("-");
}

/** print_error as Bambu's XXXX-XXXX form, or null when there is none. */
export function printErrorCode(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return null;
  const text = hex8(n);
  return `${text.slice(0, 4)}-${text.slice(4)}`;
}

const colour = (value: unknown) => (typeof value === "string" && value.length >= 6 ? `#${value.slice(0, 6)}` : undefined);

function tray(entry: any) {
  if (!entry || typeof entry !== "object") return undefined;
  const type = entry.tray_type || undefined;
  return {
    id: entry.id,
    ...(type ? { type, colour: colour(entry.tray_color), name: entry.tray_sub_brands || undefined } : { empty: true }),
  };
}

export function statusDetails(data: Record<string, any>): Record<string, unknown> {
  const nozzle = data.device?.nozzle;
  const units: any[] = Array.isArray(data.ams?.ams) ? data.ams.ams : [];
  return {
    stage: {
      gcodeState: data.gcode_state,
      printStage: data.mc_print_stage,
      subStage: data.mc_print_sub_stage,
      currentStep: data.stg_cur,
    },
    task: data.subtask_name ? { name: data.subtask_name, taskId: data.task_id, type: data.print_type } : undefined,
    printError: printErrorCode(data.print_error),
    hms: Array.isArray(data.hms) ? data.hms.map(hmsCode) : [],
    plate: data.device?.plate?.cur_id || undefined,
    nozzles: Array.isArray(nozzle?.info)
      ? {
          mountedRackId: nozzle.tar_id,
          info: nozzle.info.map((n: any) => ({ id: n.id, type: n.type, diameter: n.diameter, ...(n.sn && n.sn !== "N/A" ? { sn: n.sn } : {}) })),
        }
      : undefined,
    ams: units.map(unit => ({
      id: unit.id,
      humidity: unit.humidity,
      temperature: unit.temp,
      trays: Array.isArray(unit.tray) ? unit.tray.map(tray) : [],
    })),
    externalSpools: Array.isArray(data.vir_slot) ? data.vir_slot.map(tray) : [],
    trayNow: data.ams?.tray_now,
    lights: Array.isArray(data.lights_report) ? Object.fromEntries(data.lights_report.map((l: any) => [l.node, l.mode])) : undefined,
    wifiSignal: data.wifi_signal,
  };
}
