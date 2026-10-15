/**
 * A printer's state, rebuilt from its push reports the way Bambu Studio does it.
 *
 * Printers push `print.push_status` reports of two kinds (DeviceManager.cpp MachineObject::parse_json): a full report
 * (`msg` 0, or no `msg`, which Studio and ha-bambulab both read as full) and a delta (`msg` 1) carrying only what
 * changed. Studio keeps the last full report as a base (Utils/json_diff.cpp diff2all_base_reset) and restores every
 * delta onto it (diff2all: objects merge key by key, any other value, arrays included, replaces the base's). A delta
 * with no base can't be restored; after more than five of those Studio asks for a full push (is_need_request,
 * command_request_push_all). Its print dialog only checks a printer whose state is ready (is_info_ready): at least
 * one full report, and a push received within PUSHINFO_TIMEOUT (15 s).
 */

import { nextSequenceId } from "./sequence-id.js";

/** Studio's PUSHINFO_TIMEOUT (DeviceManager.hpp): the newest push must be at most this old for any check. */
export const PUSHINFO_TIMEOUT_MS = 15_000;
/** Studio's REQUEST_PUSH_MIN_TIME (DeviceManager.hpp): command_request_push_all sends at most one per 3 s. */
export const REQUEST_PUSH_MIN_MS = 3_000;
/** json_diff::is_need_request: more than this many deltas that couldn't be restored ask for a full push. */
const MAX_DECODE_ERRORS = 5;

type Json = Record<string, any>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

/**
 * Restore a delta onto a full report (json_diff::diff2all): keys missing from the delta keep the base's value,
 * nested objects merge key by key, and everything else in the delta (numbers, strings, arrays) replaces the base's.
 */
export function mergeReport(base: Json, delta: Json): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(delta)) {
    out[key] = isObject(value) && isObject(base[key]) ? mergeReport(base[key], value) : clone(value);
  }
  return out;
}

/** What one push did: reset the base (full), restored onto it (delta), or couldn't be used (no base yet). */
export type ReportKind = "full" | "delta" | "unrestored";

function messageKind(print: Json): "full" | "delta" {
  const msg = print.msg;
  if (msg === undefined || msg === null || Number(msg) === 0) return "full";
  // msg 1 is a delta; Studio logs other values as unsupported and parses them field by field, like a delta.
  return "delta";
}

/** One printer's restored state. Feed it every report the printer sends (LAN MQTT or the network plugin). */
export class PrinterReport {
  private base?: Json;
  /** When the base was last reset by a full report, and when any push was last merged. */
  fullAt?: number;
  receivedAt?: number;
  private decodeErrors = 0;
  /** get_version modules, which identify the printer by its serial. */
  modules?: unknown[];
  modulesAt?: number;

  /** Ingest one MQTT message (parsed JSON or text). Returns what a push_status did, or undefined for other messages. */
  ingest(message: unknown, at = Date.now()): ReportKind | undefined {
    let parsed: unknown = message;
    if (typeof message === "string" || Buffer.isBuffer(message)) {
      try { parsed = JSON.parse(String(message)); } catch { return undefined; }
    }
    if (!isObject(parsed)) return undefined;
    if (isObject(parsed.info) && parsed.info.command === "get_version" && Array.isArray(parsed.info.module)) {
      this.modules = clone(parsed.info.module);
      this.modulesAt = at;
    }
    const print = parsed.print;
    if (!isObject(print) || print.command !== "push_status") return undefined;
    if (messageKind(print) === "full") {
      this.base = clone(print);
      this.fullAt = at;
      this.receivedAt = at;
      this.decodeErrors = 0;
      return "full";
    }
    if (!this.base) {
      this.decodeErrors++;
      return "unrestored";
    }
    this.base = mergeReport(this.base, print);
    this.receivedAt = at;
    this.decodeErrors = 0;
    return "delta";
  }

  /** Studio's is_need_request: deltas keep arriving with no base to restore them onto. */
  needsFullPush(): boolean {
    return this.decodeErrors > MAX_DECODE_ERRORS;
  }

  /** Studio's is_info_ready: a full report has been restored and the newest push is recent enough. */
  isReady(now = Date.now()): boolean {
    return this.base !== undefined && this.receivedAt !== undefined && now - this.receivedAt <= PUSHINFO_TIMEOUT_MS;
  }

  /** A copy of the restored state (the `print` object of a full report with every later delta applied). */
  state(): Json | undefined {
    return this.base === undefined ? undefined : clone(this.base);
  }

  reset(): void {
    this.base = undefined;
    this.fullAt = undefined;
    this.receivedAt = undefined;
    this.decodeErrors = 0;
    this.modules = undefined;
    this.modulesAt = undefined;
  }
}

/** Studio's command_request_push_all message. */
export function pushAllMessage(sequenceId: string): { pushing: Record<string, unknown> } {
  return { pushing: { sequence_id: sequenceId, command: "pushall", version: 1, push_target: 1 } };
}

/** The minimum time between this server's full-push requests to one printer (BAMBU_PUSHALL_MIN_MS, default 3000). */
export function pushAllMinIntervalMs(): number {
  const raw = process.env.BAMBU_PUSHALL_MIN_MS?.trim();
  const value = raw ? Number(raw) : REQUEST_PUSH_MIN_MS;
  return Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : REQUEST_PUSH_MIN_MS;
}

/**
 * Reports per printer client and serial, fed by one listener per client attached the first time it's asked for
 * (before any listener added afterwards, so it has merged a report by the time those see it).
 */
const lanReports = new WeakMap<object, Map<string, PrinterReport>>();
export function lanPrinterReport(client: any, serial: string): PrinterReport {
  let reports = lanReports.get(client);
  if (!reports) {
    const byKey = new Map<string, PrinterReport>();
    reports = byKey;
    lanReports.set(client, byKey);
    client.on?.("rawMessage", (topic: unknown, payload: unknown) => {
      const match = typeof topic === "string" ? /^device\/([^/]+)\/report$/.exec(topic) : null;
      if (!match) return;
      const key = match[1].toUpperCase();
      let report = byKey.get(key);
      if (!report) { report = new PrinterReport(); byKey.set(key, report); }
      report.ingest(Buffer.isBuffer(payload) || typeof payload === "string" ? payload : String(payload));
      // Studio asks for a full push when deltas keep arriving with nothing to restore them onto.
      if (report.needsFullPush()) void requestPushAll(client).catch(() => { /* the next safety read asks again */ });
    });
    // A new connection starts over: Studio resets its state (MachineObject::reset) when it reconnects.
    client.on?.("client:disconnect", () => { for (const report of byKey.values()) report.reset(); });
  }
  const key = serial.trim().toUpperCase();
  let report = reports.get(key);
  if (!report) { report = new PrinterReport(); reports.set(key, report); }
  return report;
}

/** When this server last asked each printer client for a full push. */
const lastPushAll = new WeakMap<object, number>();
export function lastPushAllAt(client: object): number | undefined {
  return lastPushAll.get(client);
}
export function notePushAll(client: object, at = Date.now()): void {
  lastPushAll.set(client, at);
}

/**
 * Ask for a full push unless one was asked for within the minimum interval (Studio's command_request_push_all
 * without request_now: "send request too fast" is skipped). Returns whether it was sent.
 */
export async function requestPushAll(client: any, now = Date.now()): Promise<boolean> {
  const last = lastPushAll.get(client);
  if (typeof client.publish !== "function" || (last !== undefined && now - last < pushAllMinIntervalMs())) return false;
  lastPushAll.set(client, now);
  await client.publish(pushAllMessage(nextSequenceId()));
  return true;
}
