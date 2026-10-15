/**
 * The buttons Bambu Studio's error dialog offers for a print_error (DeviceErrorDialog: hms_action_<serial prefix>.json,
 * which Studio downloads into its configuration's `hms` folder). Studio only lets a person resume a job paused by an
 * error when the code's action list has a resume button, so the same list decides it here. Without the list (Studio
 * never ran on this machine, or the printer's file is missing) nothing is resumable.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** DeviceErrorDialog::ActionButton values that send command_hms_resume. */
const RESUME_ACTIONS = new Set([2, 3, 4, 12, 28]); // Resume Printing (+ defects / problem solved), Filament Loaded Resume, Problem Solved Resume

/** Where Bambu Studio keeps its downloaded HMS files (BAMBU_HMS_DIR overrides). */
export function hmsDirectories(): string[] {
  const configured = process.env.BAMBU_HMS_DIR?.trim();
  if (configured) return [configured];
  const home = os.homedir();
  if (process.platform === "darwin") return [path.join(home, "Library", "Application Support", "BambuStudio", "hms")];
  if (process.platform === "win32") return [path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "BambuStudio", "hms")];
  return [path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "BambuStudio", "hms")];
}

/** The dialog's action buttons for a print_error on the printer with this serial, or undefined when unknown. */
export function printErrorActions(serial: string, printError: number): number[] | undefined {
  const prefix = serial.trim().toUpperCase().slice(0, 3);
  if (!/^[0-9A-Z]{3}$/.test(prefix) || !Number.isInteger(printError) || printError <= 0 || printError > 0xffffffff) return undefined;
  const ecode = (printError >>> 0).toString(16).toUpperCase().padStart(8, "0");
  for (const directory of hmsDirectories()) {
    let data: unknown;
    try { data = JSON.parse(fs.readFileSync(path.join(directory, `hms_action_${prefix}.json`), "utf8"))?.data; } catch { continue; }
    if (!Array.isArray(data)) continue;
    const entry = data.find((item: any) => typeof item?.ecode === "string" && item.ecode.toUpperCase() === ecode &&
      (item.device === undefined || String(item.device).toUpperCase() === prefix));
    if (entry && Array.isArray(entry.actions)) return entry.actions.filter((action: unknown): action is number => Number.isInteger(action));
  }
  return undefined;
}

/** Whether Studio's dialog offers Resume for this print_error. */
export function printErrorResumable(serial: string, printError: number): boolean {
  return (printErrorActions(serial, printError) ?? []).some(action => RESUME_ACTIONS.has(action));
}
