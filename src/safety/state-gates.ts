/**
 * Bambu Studio's printer-state checks before it sends a print (SelectMachine.cpp SelectMachineDialog::
 * update_show_status). PrePrintChecker.hpp sorts every status into errors, which disable the Send button, and
 * warnings, which are listed next to it. The same split applies here: an error throws, a warning is returned.
 * Checks that need Studio's own UI state (its AMS mapping dialog, preset bundle) or are covered elsewhere
 * (printing states, nozzles, rack, filament blacklist) are not repeated.
 */
import { hexFlagBit } from "../ams-drying.js";

type Report = Record<string, any>;

export interface PrintStartGateOptions {
  model: string;
  /** Project filament count (Studio counts its filament presets). */
  filamentCount?: number;
  /** AMS trays the job is mapped to (unit*4+slot, AMS-HT unit ids 128-135, external 254/255). */
  trays?: number[];
  timelapse?: boolean;
  /** The highest chamber target the job sets (M141/M191), as the inspection found it. */
  maxChamberTemperature?: number;
}

// resources/printers/<type>.json support_print_without_sd: false on the P1P (C11), P1S (C12), A1 mini (N1), A1 (N2S).
const NEEDS_SD_CARD = new Set(["p1p", "p1s", "a1", "a1mini"]);
// support_chamber: false on the P1P and the A1 series.
const NO_CHAMBER = new Set(["p1p", "a1", "a1mini"]);
// printer_series: series_x1 (BL-P001/2, C13, N6, N7) and series_o (O1C/O1C2/O1D/O1E/O1S).
const SERIES_X1 = new Set(["x1", "x1c", "x1e", "x2d", "p2s"]);
const SERIES_O = new Set(["h2c", "h2d", "h2dpro", "h2s"]);

const integer = (value: unknown): number | undefined => {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isInteger(number) ? number : undefined;
};
/** DevUtil::get_flag_bits on a hex string (cfg, aux, fun). */
function hexBits(value: unknown, start: number, count: number): number | undefined {
  if (typeof value !== "string" || !/^(?:0x)?[0-9a-f]+$/i.test(value.trim())) return undefined;
  return Number((BigInt(`0x${value.trim().replace(/^0x/i, "")}`) >> BigInt(start)) & ((1n << BigInt(count)) - 1n));
}
/** Studio's check_enable_np: new-protocol reports carry cfg, fun, aux and stat. */
const newProtocol = (raw: Report) => ["cfg", "fun", "aux", "stat"].every(key => raw[key] !== undefined);

/**
 * DevStorage: 0 no card, 1 normal, 2 abnormal, 3 read-only. New-protocol printers report it in aux bits 12-13,
 * others in home_flag bits 8-9 (parse_home_flag), else the `sdcard` flag (DevStorage::ParseV1_0). Undefined when the
 * report says nothing about storage.
 */
export function sdCardState(raw: Report): number | undefined {
  if (newProtocol(raw)) {
    const aux = hexBits(raw.aux, 12, 2);
    if (aux !== undefined) return aux;
  }
  const home = integer(raw.home_flag);
  if (home !== undefined) return (home >>> 8) & 3;
  if (typeof raw.sdcard === "boolean") return raw.sdcard ? 1 : 0;
  return undefined;
}

/** DevUpgrade: upgrade_state.dis_state 2 (UpgradingInProgress), or on firmware without it the status strings. */
function isUpgrading(raw: Report): boolean {
  const upgrade = raw.upgrade_state;
  if (!upgrade || typeof upgrade !== "object") return false;
  const display = integer(upgrade.dis_state);
  if (display !== undefined) return display === 2;
  return ["DOWNLOADING", "FLASHING", "UPGRADE_REQUEST", "PRE_FLASH_START", "PRE_FLASH_SUCCESS"].includes(String(upgrade.status ?? "").toUpperCase());
}

/** The AMS unit ids a tray list draws from. */
const unitsOf = (trays: number[]) => [...new Set(trays.filter(tray => Number.isInteger(tray) && tray >= 0 && tray !== 254 && tray !== 255)
  .map(tray => tray >= 128 ? tray : Math.floor(tray / 4)))];

/**
 * Throw where Studio blocks a print on the printer's state, and return the warnings it lists. Only for print starts:
 * uploads, heating and resume have their own rules.
 */
export function printStartGates(raw: Report, options: PrintStartGateOptions): string[] {
  const warnings: string[] = [];
  const { model } = options;
  const upgrade = raw.upgrade_state && typeof raw.upgrade_state === "object" ? raw.upgrade_state : {};
  // DevUpgrade::ParseUpgrade_V1_0: cfg bit 2 overrides upgrade_state.force_upgrade.
  const forceUpgrade = typeof raw.cfg === "string" && raw.cfg.trim() ? hexBits(raw.cfg, 2, 1) === 1 : upgrade.force_upgrade === true;
  if (forceUpgrade) throw new Error("The printer's firmware must be updated before it takes a print (Bambu Studio: \"Cannot send the print job to a printer whose firmware is required to get updated.\"). Update it from the printer or Bambu Studio.");
  if (upgrade.consistency_request === true) throw new Error("The printer's modules need a firmware consistency update before it takes a print (Bambu Studio: \"Cannot send the print job to a printer whose firmware is required to get updated.\").");
  // DevInfo::IsFdmMode: device.type bit 0; an H2 with the laser or cutting module active reports another mode.
  const deviceType = integer(raw.device?.type);
  if (deviceType !== undefined && (deviceType & 1) === 0) {
    throw new Error("The printer is not in FDM mode (a laser or cutting module is active; Bambu Studio: \"Cannot send the print job when the printer is not at FDM mode\"). Switch it back to 3D printing first.");
  }
  if (isUpgrading(raw)) throw new Error("The printer is updating its firmware (Bambu Studio: \"Cannot send the print job when the printer is updating firmware\"); wait until it has finished.");
  // _parse_ams_status: main state is bits 8-15. Filament change (loading/unloading) and cold pull block printing.
  const amsStatus = integer(raw.ams_status);
  const amsMain = amsStatus !== undefined ? (amsStatus >> 8) & 0xff : undefined;
  if (amsMain === 0x01) throw new Error("The AMS is loading or unloading filament (Bambu Studio: \"The printer is busy on other print job\"); wait for the filament change to finish.");
  if (amsMain === 0x07) throw new Error("The printer is doing a cold pull (Bambu Studio: \"The printer is busy on other print job\"); wait for it to finish.");
  // DevFilaSystem::IsAmsSettingUp: ams.cali_stat low byte 1-4.
  const setup = integer(raw.ams?.cali_stat);
  if (setup !== undefined && [1, 2, 3, 4].includes(setup & 0xff)) throw new Error("The AMS is setting up (Bambu Studio: \"AMS is setting up. Please try again later.\"); wait for it to finish.");
  const sd = sdCardState(raw);
  if (sd === 0 && NEEDS_SD_CARD.has(model)) throw new Error("The printer reports no SD card, and this model can't print without one (Bambu Studio: \"Storage needs to be inserted before printing.\").");
  // LAN-mode printers take every job on their storage: no card (unless the printer has eMMC, fun2 bit 0), or a card
  // that is abnormal or read-only, blocks.
  if (raw.device?.connection_type === "lan") {
    if (sd === 0 && !hexFlagBit(raw.fun2, 0)) throw new Error("The printer is in LAN mode and reports no SD card (Bambu Studio: \"Storage needs to be inserted before printing via LAN.\").");
    if (sd === 2 || sd === 3) throw new Error(`The printer's SD card is ${sd === 2 ? "abnormal" : "read-only"} (Bambu Studio: "Storage is not available or is in read-only mode."). Replace or reformat it.`);
  }
  // get_max_filament_color_count: 32 with flag3 bit 17, 20 with the new AMS protocol (flag3 bit 9) outside the X1
  // series, 16 outside the X1 and H2 series; no limit otherwise.
  const flag3 = integer(raw.flag3);
  const bit = (value: number | undefined, index: number) => value !== undefined && ((value >>> index) & 1) === 1;
  const maxColours = bit(flag3, 17) ? 32 : bit(flag3, 9) && !SERIES_X1.has(model) ? 20 : !SERIES_X1.has(model) && !SERIES_O.has(model) ? 16 : 0;
  if (maxColours > 0 && options.filamentCount !== undefined && options.filamentCount > maxColours) {
    throw new Error(`The job has ${options.filamentCount} filaments; the printer's firmware supports at most ${maxColours} (Bambu Studio's PrintStatusColorQuantityExceed). Re-slice with fewer or update the firmware.`);
  }

  // Warnings.
  if (amsMain === 0x02) warnings.push("the AMS is reading filament RFID tags; a tray's reported material may still change");
  // is_selected_ams_drying: a mapped AMS is drying (info bits 4-7: checking, drying, error, overheating), where the
  // printer reports remote drying (fun2 bit 5).
  if (hexFlagBit(raw.fun2, 5) && options.trays?.length) {
    const units: any[] = Array.isArray(raw.ams?.ams) ? raw.ams.ams : [];
    for (const id of unitsOf(options.trays)) {
      const unit = units.find(value => Number(value?.id) === id);
      const status = hexBits(unit?.info, 4, 4);
      if (status !== undefined && [1, 2, 5, 6].includes(status)) warnings.push(`AMS ${id >= 128 ? `HT ${id}` : id} is drying filament; printing from it stops or slows the drying`);
    }
  }
  if (options.timelapse) {
    // check_sdcard_for_timelpase: timelapse without a card, a timelapse kit (aux bit 26) or internal timelapse (fun bit 28).
    const internal = hexBits(raw.fun, 28, 1) === 1;
    if (sd === 0 && hexBits(raw.aux, 26, 1) !== 1 && !internal) warnings.push("timelapse is on but the printer has no SD card, so none will be recorded (Bambu Studio: \"Storage needs to be inserted to record timelapse.\")");
    // check_timelapse_storage_warning: under 20 MB free on the timelapse storage (device.cam tl_*_free_kb).
    const cam = raw.device?.cam;
    if (internal && cam && typeof cam === "object") {
      for (const [storage, key] of [["internal", "tl_internal_free_kb"], ["external", "tl_external_free_kb"]] as const) {
        const free = integer(cam[key]);
        const total = integer(cam[key.replace("free", "total")]);
        if (free !== undefined && free >= 0 && free < 20480 && (total === undefined || total > 0)) warnings.push(`${storage} timelapse storage has less than 20 MB free; the timelapse may not save`);
      }
    }
  }
  // PrintStatusFilamentWarningHighChamberTemp(CloseDoor): a job that wants a chamber at 40 °C or more.
  if (options.maxChamberTemperature !== undefined && options.maxChamberTemperature >= 40) {
    warnings.push(NO_CHAMBER.has(model)
      ? "this job needs a high-temperature environment"
      : "this job heats the chamber; close the door if it isn't closed");
  }
  return warnings;
}
