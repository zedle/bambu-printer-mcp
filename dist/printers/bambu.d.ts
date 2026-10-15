import { printerReplyField, type CommandReply } from "../command-reply.js";
import { inspectPrintFile } from "../safety/print-file.js";
import { type PrinterStateRequirements } from "../safety/printer-state.js";
import { type ControlCommand } from "./control-commands.js";
/**
 * Whether the printer only takes signed `print` commands. Bambu's network plugin decides this from the printer's
 * own push_status (plugin 02.08.02.54 filter_security_flag): `fun` bit 29 when `fun` is present, else `flag3` bit 4,
 * else no. Firmware that sets it refuses an unsigned print with HMS 0500-0500-0001-0007, unless LAN Only Mode and
 * Developer Mode are both on, which the report doesn't show.
 */
export declare function printerRequiresSignedCommands(raw: Record<string, any> | undefined): boolean;
/** Opt-in for unsigned LAN prints on a printer that reports signing (LAN Only + Developer Mode, not visible in the report). */
export declare function unsignedLanPrintAllowed(): boolean;
export declare const UNSIGNED_PRINT_REFUSED_MESSAGE: string;
export declare function assertUnsignedPrintAccepted(status: any): void;
export type LanProjectFileOptions = {
    sequenceId: string;
    platePath: string;
    file: string;
    url: string;
    subtaskName: string;
    md5: string;
    bedType?: string;
    timelapse: boolean;
    bedLeveling: boolean;
    flowCalibration: boolean;
    vibrationCalibration: boolean;
    layerInspect: boolean;
    useAms: boolean;
    amsMapping: number[];
    amsMapping2: Array<{
        ams_id: number;
        slot_id: number;
    }>;
    nozzleMapping?: unknown;
    autoBedLeveling: number;
    extrudeCaliFlag: number;
    nozzleOffsetCali: number;
    extrudeCaliManualMode: number;
};
/**
 * The LAN `project_file` command as Bambu's network plugin builds it in start_local_print (plugin 02.08.02.54):
 * the task options are JSON booleans, the calibration modes ints, the four ids "0", a fresh sequence id, the
 * project name as subtask_name, bed_type "auto" when unset, extrude_cali_manual_mode only when it isn't -1, nozzle_mapping only
 * when set, and cfg the hex flag string ("0": no external-change assist, no internal timelapse storage).
 * ams_mapping_info and nozzles_info are never sent on LAN.
 */
export declare function buildLanProjectFile(options: LanProjectFileOptions): {
    print: Record<string, unknown>;
};
/**
 * Serious and common HMS entries (and the other non-blocking states validatePrinterState reports) don't stop a
 * print, as in Bambu Studio, but the caller must see them: every print route adds them to its result the same way.
 */
export declare function withHmsWarnings<T extends Record<string, unknown>>(result: T, hmsWarnings: readonly string[] | undefined): T & {
    hmsWarnings?: string[];
};
/**
 * Bambu Studio's clear-error command (MachineObject::command_clean_print_error): the job's subtask_id and the
 * print_error being cleared, from a fresh report; the bare form leaves the error in place. Every route (LAN MQTT,
 * the signed bridge, the native helper) sends this one shape.
 */
export declare function buildCleanPrintError(raw: Record<string, any> | undefined, sequenceId?: string): {
    print: Record<string, unknown>;
};
/**
 * Bambu Studio's acknowledgement that the error's dialog was closed (MachineObject::command_clean_print_error_uiop),
 * sent with clean_print_error when the person confirms the error (DeviceErrorDialog DBL_CHECK_OK) and whenever its
 * error dialog closes: `{"system": {"command": "uiop", "name": "print_error", "action": "close", "source": 1,
 * "type": "dialog", "err": "<print_error as 8 hex digits>"}}` (source 1 = Studio, 0 = the printer's own screen).
 */
export declare function buildCleanPrintErrorUiop(printError: number, sequenceId?: string): {
    system: Record<string, unknown>;
};
/**
 * Bambu Studio's resume: command_task_resume (`resume`, param "") after a pause the person made, command_hms_resume
 * (`resume` with the print_error in decimal as `err`, param "reserve" and the report's job_id) for a job paused by
 * an error, which is what its error dialog's Resume buttons send.
 */
export declare function buildResumeCommand(raw: Record<string, any> | undefined, sequenceId?: string): {
    print: Record<string, unknown>;
};
/** A print the printer confirmed is "success"; one sent but not yet seen running is reported apart from it. */
export declare function dispatchStatusLabel(dispatch: "started" | "unconfirmed"): "success" | "dispatched_unconfirmed";
type DispatchVerdict = {
    kind: "started";
} | {
    kind: "rejected";
} | {
    kind: "failed";
    message: string;
} | {
    kind: "cancelled";
};
/**
 * What a printer report says about a print command just sent (`before` = the report from right before it):
 * - rejected: a new HMS 0500-0500-0001-0007 (an unsigned command refused);
 * - failed: the printer's project_file reply says "fail" (Studio: "Failed to start printing job"), or this job is
 *   reported FAILED, or a new print_error appeared;
 * - started: a printing state for this job: its name as subtask_name or gcode_file, a new task id, or (when the
 *   report or pushed delta names no job) a printer that was idle before.
 */
export declare function judgeDispatchReport(report: any, before: any, jobName: string | undefined): DispatchVerdict | undefined;
/**
 * The printer's reply to a print command (project_file / gcode_file): a refusal ("fail", a non-zero err_code) means
 * the job didn't start (Bambu Studio's "Failed to start printing job"); an accepted reply alone doesn't prove it did.
 */
export declare function dispatchReplyVerdict(reply: CommandReply | undefined): DispatchVerdict | undefined;
/** The printer's reply to a print command, as print results carry it (`printerReply`), when one arrived. */
export declare function dispatchReplyField(reply: CommandReply | undefined): {
    printerReply?: ReturnType<typeof printerReplyField>;
};
export declare function assertDirectPrintSupported(model: string | undefined, serial?: string): void;
interface BambuPrintOptionsInternal {
    projectName: string;
    filePath: string;
    bambuModel?: string;
    nozzleDiameters?: number[];
    useAMS?: boolean;
    plateIndex?: number;
    bedType?: string;
    /** true/false or "on"/"off"/"auto"; omitted means Bambu Studio's default for the model (print-options.ts). */
    bedLeveling?: unknown;
    flowCalibration?: unknown;
    nozzleOffsetCalibration?: unknown;
    vibrationCalibration?: unknown;
    layerInspect?: unknown;
    timelapse?: boolean;
    amsMapping?: number[];
    /**
     * Per-used-filament absolute tray index, one entry per position in the
     * selected plate's `filament_ids`. Example: plate uses project filament 1
     * only, and you want to pull from AMS 0 tray 1 -> pass `[1]`. The server
     * expands this into the project-level `ams_mapping` array at the right
     * position automatically (H2-series). Preferred over `amsMapping` for
     * ergonomic callers; `amsMapping` takes precedence if both are set.
     */
    amsSlots?: number[];
    md5?: string;
}
/** Publish a query and resolve with the first report `match` accepts within `waitMs`, or undefined. */
export declare function queryLanPrinter<T>(printer: any, message: Record<string, unknown>, match: (message: unknown) => T | undefined, waitMs: number): Promise<T | undefined>;
export declare function uniqueModules(modules: unknown[]): unknown[];
export declare class BambuImplementation {
    private readonly confirm?;
    private printerStore;
    private checkedJobs;
    private clearedErrors;
    constructor(confirm?: ((message: string) => Promise<boolean>) | undefined);
    confirmHardwareAction(message: string, _physicalCheck?: boolean): Promise<void>;
    private finishedJobIdentity;
    confirmPrintPreflight(serial: string, status: any, inspection: Awaited<ReturnType<typeof inspectPrintFile>>): Promise<string | undefined>;
    assertBedClearance(status: any, confirmedFinishedJob: string | undefined): void;
    private getPrinter;
    /** Internal handoff from a successful inspected transport; never exposed as an MCP tool. */
    recordCheckedJob(host: string, serial: string, remotePath: string, requirements: PrinterStateRequirements): void;
    private validateLoadedGcodeState;
    /** Validate a fresh report for a print: loaded-filament checks for a legacy gcode_file job, the mapped checks otherwise. */
    private validatePrintState;
    private resolveProjectFileMetadata;
    /** Safety reads never use the display cache or configured-serial model inference. */
    getSafetyStatus(host: string, serial: string, token: string): Promise<any>;
    getStatus(host: string, serial: string, token: string): Promise<any>;
    print3mf(host: string, serial: string, token: string, options: BambuPrintOptionsInternal): Promise<any>;
    private print3mfPrepared;
    cancelJob(host: string, serial: string, token: string, dispatch?: () => Promise<any>): Promise<any>;
    pauseJob(host: string, serial: string, token: string, dispatch?: () => Promise<any>): Promise<any>;
    resumeJob(host: string, serial: string, token: string, dispatch?: (assertActive: () => void, beforeDispatch: () => Promise<void>, command: {
        print: Record<string, unknown>;
    }) => Promise<any>): Promise<any>;
    clearHmsErrors(host: string, serial: string, token: string, dispatch?: (assertActive: () => void, beforeDispatch: () => Promise<void>, command: {
        print: Record<string, unknown>;
    } | {
        system: Record<string, unknown>;
    }) => Promise<any>): Promise<any>;
    setPrintSpeed(host: string, serial: string, token: string, speedMode: string | number): Promise<any>;
    /** Send a control-commands.ts command: through the dispatch callback (signed) or LAN MQTT with reply matching. */
    private sendControl;
    setAirductMode(host: string, serial: string, token: string, mode: string, dispatch?: (command: ControlCommand) => Promise<any>, coolingFilter?: boolean): Promise<any>;
    rereadAmsRfid(host: string, serial: string, token: string, amsId: number, slotId: number, dispatch?: (command: ControlCommand) => Promise<any>): Promise<any>;
    /**
     * Heaters, with the command form Studio uses for the printer (control-commands.ts). On dual-nozzle printers the
     * nozzle is chosen with extruder (0 right/main, 1 left/deputy); turning a nozzle off without one turns both off.
     */
    setTemperature(host: string, serial: string, token: string, component: string, temperature: unknown, bambuModel?: string, material?: string, nozzleDiameter?: number, dispatch?: (command: ControlCommand, assertActive: () => void, beforeDispatch?: () => Promise<void>) => Promise<any>, extruder?: number): Promise<{
        status: string;
        message: string;
        command: string;
    }>;
    setFanSpeed(host: string, serial: string, token: string, fan: string | number, speed: number, dispatch?: (command: ControlCommand) => Promise<any>): Promise<{
        status: string;
        message: string;
        fan: number;
        speed: number;
        requested_speed: number;
        command: string;
    }>;
    setLight(host: string, serial: string, token: string, light: string, mode: string): Promise<{
        status: string;
        message: string;
        light: string;
        mode: string;
    }>;
    /** Tool arguments: action, ams_id and, to start, filament, temperature, duration_hours (see normalizeAmsDryingRequest). */
    setAmsDrying(host: string, serial: string, token: string, args: Record<string, unknown>): Promise<any>;
    skipObjects(host: string, serial: string, token: string, objectIds: number[]): Promise<{
        status: string;
        message: string;
        object_ids: number[];
    }>;
    getFiles(host: string, serial: string, token: string): Promise<{
        files: string[];
        directories: Record<string, string[]>;
    }>;
    getFile(host: string, serial: string, token: string, filename: string): Promise<{
        name: string;
        exists: boolean;
    }>;
    uploadFile(host: string, serial: string, token: string, filePath: string, filename: string, print: boolean, bambuModel?: string, upload?: (snapshot: string, destination: string, assertActive: () => void) => Promise<void>): Promise<{
        status: string;
        uploaded: boolean;
        remotePath: string;
        printRequested: boolean;
        inspected: boolean;
    } | ({
        message: string;
        printerReply?: ReturnType<typeof printerReplyField>;
        status: "success" | "dispatched_unconfirmed";
        uploaded: boolean;
        printRequested: boolean;
        dispatch: "started" | "unconfirmed";
        remotePath: string;
    } & {
        hmsWarnings?: string[];
    })>;
    private printRawPrepared;
    /**
     * A published print command is not proof the printer took it. Listen to the
     * reports the printer pushes anyway (no extra pushall polling on weak P1
     * boards): a new command-verification HMS means the firmware refused the
     * command; PREPARE/SLICING/RUNNING for this job means it started. Attach before publishing.
     */
    private watchDispatch;
    private settleDispatch;
    /**
     * Confirm a job handed to Bambu's network plugin from the printer's own reports, as Studio waits for the job
     * (PrintJob wait_fn) instead of trusting the plugin's return code: poll fresh full reports (Studio's minimum
     * pushall interval, 3 s) for up to BAMBU_DISPATCH_CHECK_MS. "started" needs this job's name in the report or a
     * new task id with a printing state; a refusal or a failed start throws; otherwise "unconfirmed".
     */
    confirmDispatchedJob(host: string, serial: string, token: string, before: any, jobName: string, assertActive: () => void, replies?: {
        poll: () => Promise<CommandReply | undefined>;
        reply?: CommandReply;
    }): Promise<"started" | "unconfirmed">;
    startJob(host: string, serial: string, token: string, filename: string, bambuModel?: string): Promise<{
        message: string;
        printerReply?: ReturnType<typeof printerReplyField>;
        status: "success" | "dispatched_unconfirmed";
        uploaded: boolean;
        printRequested: boolean;
        dispatch: "started" | "unconfirmed";
        remotePath: string;
    } & {
        hmsWarnings?: string[];
    }>;
    private ftpDownload;
    /**
     * Capture a single JPEG frame from the printer's chamber camera.
     *
     * Protocol per https://github.com/Doridian/OpenBambuAPI/blob/main/video.md
     *
     *   Connect TLS to <host>:6000 (self-signed cert -- skip verification).
     *   Send an 80-byte auth packet:
     *     [0..4]   uint32 LE  payload size = 0x40  (64)
     *     [4..8]   uint32 LE  type         = 0x3000
     *     [8..12]  uint32 LE  flags        = 0
     *     [12..16] uint32 LE  0
     *     [16..48] "bblp" + null padding to 32 bytes
     *     [48..80] access token + null padding to 32 bytes
     *
     *   The server then streams frames as repeating:
     *     [0..4]   uint32 LE  payload size
     *     [4..8]   uint32 LE  itrack (0)
     *     [8..12]  uint32 LE  flags  (1)
     *     [12..16] uint32 LE  0
     *     [16..16+payloadSize] JPEG (FF D8 ... FF D9)
     *
     * Verified models per upstream docs: A1, A1 mini, P1S, P1P. X1/X1C/X1E
     * and P2S use RTSP on port 322 instead. H2/H2S/H2D/H2C/X2D
     * use the same RTSP path.
     *
     * Read-only; no confirm gate. Default 8s timeout for cold-start latency.
     */
    cameraSnapshot(host: string, _serial: string, token: string, options?: {
        savePath?: string;
        timeoutMs?: number;
        bambuModel?: string;
        /**
         * Reserved. Earlier this flag let callers probe the H2 series via
         * the A1/P1 TCP-on-6000 path. Diagnostics confirmed the printer
         * does not speak that protocol; H2 uses RTSP, same as X1. The
         * flag is now ignored. Kept on the type to avoid breaking
         * existing callers.
         */
        experimental?: boolean;
        /**
         * Optional override for the ffmpeg binary path used by the RTSP
         * path. Defaults to `ffmpeg` (relies on $PATH).
         */
        ffmpegPath?: string;
    }): Promise<{
        status: string;
        format: string;
        sizeBytes: number;
        base64: string;
        savedTo?: string;
        width?: number;
        height?: number;
        note?: string;
        transport?: "tcp-6000" | "rtsps-322";
    }>;
    /**
     * Pull a single JPEG frame from the printer's RTSP/RTSPS stream using
     * ffmpeg. Used for X1, P2S, H2-family printers, and X2D.
     *
     * URL pattern verified against HA bambulab's models.py example:
     *   rtsps://bblp:<access_code>@<host>:322/streaming/live/1
     *
     * ffmpeg invocation:
     *   ffmpeg -tls_verify 0 -rtsp_transport tcp -i <url> -frames:v 1 -f image2 -c:v mjpeg -y <out>
     *
     * -tls_verify 0 accepts the printer's self-signed certificate. This is
     * consistent with the existing local-device TLS/FTPS paths, which do not
     * have a public CA chain or hostname that ffmpeg can validate. The
     * connection is still encrypted and remains scoped to the configured
     * printer host. -rtsp_transport tcp avoids UDP NAT/firewall issues.
     * -frames:v 1 makes ffmpeg exit as soon as one frame lands. -y overwrites
     * the temp file.
     */
    private fetchRtspCameraFrame;
    /**
     * Open the TLS-on-6000 socket, send the 80-byte auth packet, and read
     * a single complete JPEG frame. Returns the JPEG bytes.
     */
    private fetchTcpCameraFrame;
    /**
     * Delete a single file from the printer's SD card via FTPS.
     *
     * Destructive. Caller MUST set confirm=true; otherwise we return without
     * touching the printer. Path is normalized the same way uploadFile()
     * normalizes -- if the caller passes a bare filename, we look in cache/.
     * Path traversal (`..`) is rejected.
     *
     * Only the printer-managed directories (cache/, timelapse/, logs/) are
     * accepted as parents to avoid letting an agent wander further into the
     * filesystem than expected.
     */
    deleteFile(host: string, _serial: string, token: string, filename: string, confirm: unknown): Promise<{
        status: string;
        deleted: boolean;
        remotePath: string;
        message?: string;
    }>;
    /**
     * Delete a single remote file via FTPS, using basic-ftp directly so we
     * get the same TLS-session-ticket handshake as ftpUpload().
     */
    private ftpDelete;
    /**
     * Upload a file to the printer via FTP using basic-ftp directly.
     * Bypasses bambu-js's sendFile which has a double-path bug (ensureDir CDs
     * into the target directory, then uploadFrom uses the full relative path
     * again, resulting in e.g. /cache/cache/file.3mf).
     */
    private ftpUpload;
    private waitForTlsSession;
    disconnectAll(): Promise<void>;
}
export {};
