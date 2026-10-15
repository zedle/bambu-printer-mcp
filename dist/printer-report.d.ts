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
/** Studio's PUSHINFO_TIMEOUT (DeviceManager.hpp): the newest push must be at most this old for any check. */
export declare const PUSHINFO_TIMEOUT_MS = 15000;
/** Studio's REQUEST_PUSH_MIN_TIME (DeviceManager.hpp): command_request_push_all sends at most one per 3 s. */
export declare const REQUEST_PUSH_MIN_MS = 3000;
type Json = Record<string, any>;
/**
 * Restore a delta onto a full report (json_diff::diff2all): keys missing from the delta keep the base's value,
 * nested objects merge key by key, and everything else in the delta (numbers, strings, arrays) replaces the base's.
 */
export declare function mergeReport(base: Json, delta: Json): Json;
/** What one push did: reset the base (full), restored onto it (delta), or couldn't be used (no base yet). */
export type ReportKind = "full" | "delta" | "unrestored";
/** One printer's restored state. Feed it every report the printer sends (LAN MQTT or the network plugin). */
export declare class PrinterReport {
    private base?;
    /** When the base was last reset by a full report, and when any push was last merged. */
    fullAt?: number;
    receivedAt?: number;
    private decodeErrors;
    /** get_version modules, which identify the printer by its serial. */
    modules?: unknown[];
    modulesAt?: number;
    /** Ingest one MQTT message (parsed JSON or text). Returns what a push_status did, or undefined for other messages. */
    ingest(message: unknown, at?: number): ReportKind | undefined;
    /** Studio's is_need_request: deltas keep arriving with no base to restore them onto. */
    needsFullPush(): boolean;
    /** Studio's is_info_ready: a full report has been restored and the newest push is recent enough. */
    isReady(now?: number): boolean;
    /** A copy of the restored state (the `print` object of a full report with every later delta applied). */
    state(): Json | undefined;
    reset(): void;
}
/** Studio's command_request_push_all message. */
export declare function pushAllMessage(sequenceId: string): {
    pushing: Record<string, unknown>;
};
/** The minimum time between this server's full-push requests to one printer (BAMBU_PUSHALL_MIN_MS, default 3000). */
export declare function pushAllMinIntervalMs(): number;
export declare function lanPrinterReport(client: any, serial: string): PrinterReport;
export declare function lastPushAllAt(client: object): number | undefined;
export declare function notePushAll(client: object, at?: number): void;
/**
 * Ask for a full push unless one was asked for within the minimum interval (Studio's command_request_push_all
 * without request_now: "send request too fast" is skipped). Returns whether it was sent.
 */
export declare function requestPushAll(client: any, now?: number): Promise<boolean>;
export {};
