import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nextSequenceId } from "./sequence-id.js";
import { assertCommandAccepted, commandReplyWaitMs, commandSequenceId, matchCommandReply } from "./command-reply.js";
import { PrinterReport } from "./printer-report.js";
const FRAME_MAGIC = 0x52424a50;
const FRAME_HEADER_SIZE = 16;
const FRAME_TYPE_JSON_REQUEST = 1;
const FRAME_TYPE_JSON_RESPONSE = 2;
const FRAME_TYPE_BINARY_DATA = 3;
const FRAME_TYPE_LOG = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
/**
 * Print methods upload the job (to Bambu's cloud for start_print) before they return, and Studio puts no time limit
 * on them. Give them far longer than ordinary calls; past it the job may still start, so the caller is told so.
 */
const PRINT_REQUEST_TIMEOUT_MS = 20 * 60000;
export const BRIDGE_PRINT_METHODS = new Set([
    "net.start_print", "net.start_local_print", "net.start_local_print_with_record", "net.start_sdcard_print", "net.start_send_gcode_to_sdcard",
]);
/**
 * A print request reached the bridge, but no answer came back (timeout, bridge exit). The plugin may still upload
 * and start the job, so it must never be sent again automatically.
 */
export class BridgeDispatchUncertainError extends Error {
    constructor(method, reason) {
        super(`The print request (${method}) reached Bambu's network plugin, but ${reason}. The job may still upload and start. ` +
            "Do not send it again: check get_printer_status (gcode_state and the job name) first.");
        this.method = method;
        this.reason = reason;
        this.name = "BridgeDispatchUncertainError";
    }
}
/** Reject a request; a print request that may already be running is reported as uncertain. */
function rejectPending(pending, error) {
    if (pending.dispatched && BRIDGE_PRINT_METHODS.has(pending.method) && !(error instanceof BridgeDispatchUncertainError)) {
        pending.reject(new BridgeDispatchUncertainError(pending.method, error.message.replace(/\.$/, "")));
    }
    else {
        pending.reject(error);
    }
}
export function defaultBambuNetworkConfigDir() {
    return path.join(os.homedir(), ".config", "bambu-printer-mcp", "bambu-network");
}
function shellQuote(value) {
    return `'${value.replace(/'/g, "'\\''")}'`;
}
function trimEnv(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
function fileExists(filePath) {
    try {
        return fs.existsSync(filePath);
    }
    catch {
        return false;
    }
}
function resolveFirstExistingDirectory(candidates) {
    return candidates.find((candidate) => fileExists(candidate) && fs.statSync(candidate).isDirectory());
}
function resolveFirstDirectoryWithFile(candidates, requiredFile) {
    return candidates.find((candidate) => fileExists(candidate) &&
        fs.statSync(candidate).isDirectory() &&
        fileExists(path.join(candidate, requiredFile)));
}
function collectMissingFiles(baseDir, files) {
    if (!baseDir)
        return files;
    return files.filter((file) => !fileExists(path.join(baseDir, file)));
}
function readFrameJson(payload) {
    const text = payload.toString("utf8");
    return text.length > 0 ? JSON.parse(text) : {};
}
function isBridgeFailure(value) {
    return (typeof value === "object" &&
        value !== null &&
        value.ok === false);
}
function bridgeValueAsNumber(value, method) {
    if (typeof value === "object" &&
        value !== null &&
        typeof value.value === "number") {
        return value.value;
    }
    throw new Error(`FULU BambuNetwork bridge method ${method} did not return a numeric value.`);
}
/** Folder holding Bambu's slicer_base64.cer client certificate for the network plugin. */
function resolveCertDir() {
    const candidates = [
        trimEnv(process.env.BAMBU_NETWORK_CERT_DIR),
        trimEnv(process.env.BAMBU_PROFILES_ROOT) ? path.join(path.dirname(trimEnv(process.env.BAMBU_PROFILES_ROOT)), "cert") : undefined,
        trimEnv(process.env.PJARCZAK_BAMBU_PLUGIN_DIR),
    ];
    return candidates.find(dir => !!dir && fs.existsSync(path.join(dir, "slicer_base64.cer")));
}
function assertBridgeOk(value, method) {
    if (isBridgeFailure(value)) {
        const errorText = value.error === undefined ? "unknown bridge error" : String(value.error);
        throw new Error(`FULU BambuNetwork bridge method ${method} failed: ${errorText}`);
    }
}
export class BambuNetworkBridge {
    constructor() {
        this.stdoutBuffer = Buffer.alloc(0);
        this.pending = new Map();
        this.nextRequestId = 1;
        this.lastStderr = "";
        this.recentLogs = [];
        this.subscribedDevices = new Set();
        this.localChannels = new Set();
        /** Each printer's state restored from the plugin's on_message / on_local_message pushes (printer-report.ts). */
        this.printerReports = new Map();
        /** Recent printer messages that aren't status pushes (command replies), kept so a reply polled once isn't lost. */
        this.recentReplies = [];
    }
    resolveBridgeCommand(override) {
        return (trimEnv(override) ||
            trimEnv(process.env.BAMBU_NETWORK_BRIDGE_COMMAND) ||
            trimEnv(process.env.FULU_BAMBU_NETWORK_BRIDGE_COMMAND) ||
            trimEnv(process.env.PJARCZAK_BAMBU_BRIDGE_COMMAND) ||
            "");
    }
    resolveConfigDir(override) {
        return (trimEnv(override) ||
            trimEnv(process.env.BAMBU_NETWORK_CONFIG_DIR) ||
            trimEnv(process.env.PJARCZAK_BAMBU_PROBE_LOG_DIR) ||
            defaultBambuNetworkConfigDir());
    }
    resolveCountryCode(override) {
        return (trimEnv(override) ||
            trimEnv(process.env.BAMBU_NETWORK_COUNTRY_CODE) ||
            trimEnv(process.env.PJARCZAK_BAMBU_COUNTRY_CODE) ||
            "US");
    }
    getStatus(options = {}) {
        const command = this.resolveBridgeCommand(options.bridgeCommand);
        const configDir = this.resolveConfigDir(options.configDir);
        const countryCode = this.resolveCountryCode(options.countryCode);
        const macosRuntimeDir = trimEnv(process.env.PJARCZAK_MAC_RUNTIME_DIR) ||
            path.join(os.homedir(), "Library", "Application Support", "OrcaSlicer", "macos-bridge", "runtime");
        const macosPluginDir = trimEnv(process.env.BAMBU_NETWORK_PLUGIN_DIR) ||
            trimEnv(process.env.PJARCZAK_BAMBU_PLUGIN_DIR) ||
            resolveFirstDirectoryWithFile([
                path.join(os.homedir(), "Library", "Application Support", "OrcaSlicer", "plugins"),
                "/Applications/Orca Studio.app/Contents/MacOS",
                "/Applications/OrcaSlicer.app/Contents/MacOS",
                "/Applications/OrcaSlicer-BMCU.app/Contents/MacOS",
                "/Applications/Orca Studio.app/Contents/Resources",
                "/Applications/OrcaSlicer.app/Contents/Resources",
                "/Applications/OrcaSlicer-BMCU.app/Contents/Resources",
                macosRuntimeDir,
            ], "pjarczak-bambu-linux-host-wrapper") ||
            resolveFirstExistingDirectory([macosRuntimeDir]);
        const runtimeRequiredFiles = [
            "libbambu_networking.so",
            "libBambuSource.so",
            "pjarczak_bambu_linux_host",
            "pjarczak_bambu_linux_host_abi1",
            "pjarczak_bambu_linux_host_abi0",
            "ca-certificates.crt",
            "slicer_base64.cer",
        ];
        const pluginRequiredFiles = [
            "pjarczak-bambu-linux-host-wrapper",
            "install_runtime_macos.sh",
            "verify_runtime_macos.sh",
        ];
        let suggestedMacCommand;
        if (macosPluginDir) {
            const wrapper = path.join(macosPluginDir, "pjarczak-bambu-linux-host-wrapper");
            const host = path.join(macosRuntimeDir, "pjarczak_bambu_linux_host");
            suggestedMacCommand =
                `PJARCZAK_BAMBU_PLUGIN_DIR=${shellQuote(macosRuntimeDir)} ` +
                    `${shellQuote(wrapper)} ${shellQuote(host)}`;
        }
        return {
            configured: command.length > 0,
            command,
            platform: process.platform,
            running: Boolean(this.child && this.child.exitCode === null),
            pid: this.child?.pid,
            configDir,
            countryCode,
            agentReady: this.agentId !== undefined,
            lastStderr: this.lastStderr,
            recentLogs: this.recentLogs.slice(-10),
            runtime: {
                macosRuntimeDir,
                macosRuntimeDirExists: fileExists(macosRuntimeDir),
                macosPluginDir,
                macosPluginDirExists: macosPluginDir ? fileExists(macosPluginDir) : undefined,
                macosMissingRuntimeFiles: collectMissingFiles(macosRuntimeDir, runtimeRequiredFiles),
                macosMissingPluginFiles: collectMissingFiles(macosPluginDir, pluginRequiredFiles),
                suggestedMacCommand,
            },
            note: command
                ? undefined
                : "Set BAMBU_NETWORK_BRIDGE_COMMAND to the FULU OrcaSlicer-bambulab Linux host or macOS/WSL wrapper command.",
        };
    }
    async request(method, payload = {}, options = {}) {
        if (!method.trim()) {
            throw new Error("BambuNetwork bridge method is required.");
        }
        await this.ensureStarted(options.bridgeCommand);
        await options.beforeDispatch?.(method);
        const id = this.nextRequestId++;
        const requestPayload = Buffer.from(JSON.stringify({ method, payload }), "utf8");
        const frame = Buffer.alloc(FRAME_HEADER_SIZE + requestPayload.length);
        frame.writeUInt32LE(FRAME_MAGIC, 0);
        frame.writeUInt32LE(FRAME_TYPE_JSON_REQUEST, 4);
        frame.writeUInt32LE(id, 8);
        frame.writeUInt32LE(requestPayload.length, 12);
        requestPayload.copy(frame, FRAME_HEADER_SIZE);
        const printMethod = BRIDGE_PRINT_METHODS.has(method);
        const timeoutMs = options.timeoutMs ?? (printMethod ? PRINT_REQUEST_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS);
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const pending = this.pending.get(id);
                this.pending.delete(id);
                if (!pending)
                    return;
                if (pending.dispatched && printMethod) {
                    // Ask the host to stop the job before it goes further (the plugin polls was_cancelled); it may be too late.
                    const jobId = Number(payload.client_job_id);
                    if (Number.isFinite(jobId))
                        void this.request("bridge.job_cancel", { job_id: jobId, cancel: true }, { timeoutMs: 5000 }).catch(() => { });
                    rejectPending(pending, new Error(`it did not answer within ${Math.round(timeoutMs / 1000)} s (a cancel was requested)`));
                }
                else {
                    reject(new Error(`Timed out waiting for FULU BambuNetwork bridge method ${method}.`));
                }
            }, timeoutMs);
            const entry = { method, resolve, reject, timer };
            this.pending.set(id, entry);
            try {
                options.assertDispatchAllowed?.(method);
                this.child.stdin.write(frame, (error) => {
                    if (error) {
                        const pending = this.pending.get(id);
                        if (pending) {
                            clearTimeout(pending.timer);
                            this.pending.delete(id);
                            pending.reject(error);
                        }
                    }
                });
                entry.dispatched = true;
                options.onDispatched?.(method);
            }
            catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }
    async ensureAgent(options = {}) {
        const command = this.resolveBridgeCommand(options.bridgeCommand);
        const configDir = this.resolveConfigDir(options.configDir);
        const countryCode = this.resolveCountryCode(options.countryCode);
        const userInfo = trimEnv(options.userInfo) || trimEnv(process.env.BAMBU_NETWORK_USER_INFO) || "";
        const key = `${command}\n${configDir}\n${countryCode}\n${userInfo}`;
        if (this.agentId !== undefined && this.agentKey === key) {
            return { agent: this.agentId, handshake: this.handshake };
        }
        fs.mkdirSync(configDir, { recursive: true });
        this.handshake = await this.request("bridge.handshake", {}, options);
        assertBridgeOk(this.handshake, "bridge.handshake");
        if (this.needsExpectedVersionRetry(this.handshake) && !trimEnv(process.env.PJARCZAK_EXPECTED_BAMBU_NETWORK_VERSION)) {
            this.inferredExpectedNetworkVersion = this.handshake.network_actual_abi_version;
            await this.stop();
            this.handshake = await this.request("bridge.handshake", {}, options);
            assertBridgeOk(this.handshake, "bridge.handshake");
        }
        const created = await this.request("net.create_agent", { log_dir: configDir, country_code: countryCode }, options);
        assertBridgeOk(created, "net.create_agent");
        const agent = bridgeValueAsNumber(created, "net.create_agent");
        const withAgent = async (method, payload = {}, hardFail = true) => {
            const response = await this.request(method, { ...payload, agent }, options);
            if (hardFail)
                assertBridgeOk(response, method);
            return response;
        };
        await withAgent("net.set_config_dir", { config_dir: configDir });
        await withAgent("net.init_log");
        // Bambu Studio's order (GUI_App.cpp): the plugin's TLS client certificate and the client headers come before
        // start. Without them the agent signs in but never reaches Bambu's cloud (is_server_connected stays false).
        const certDir = resolveCertDir();
        if (certDir)
            await withAgent("net.set_cert_file", { folder: certDir, filename: "slicer_base64.cer" }, false);
        await withAgent("net.set_country_code", { country_code: countryCode });
        const clientVersion = typeof this.handshake?.network_actual_abi_version === "string"
            ? this.handshake.network_actual_abi_version : "02.08.02.54";
        await withAgent("net.set_extra_http_header", { headers: {
                "X-BBL-Client-Type": "slicer", "X-BBL-Client-Name": "BambuStudio", "X-BBL-Client-Version": clientVersion,
                "X-BBL-OS-Type": process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux", "X-BBL-Language": "en",
            } }, false);
        await withAgent("net.start");
        await withAgent("net.connect_server", {}, false);
        if (userInfo) {
            await withAgent("net.change_user", { user_info: userInfo });
        }
        this.subscribedDevices.clear();
        this.localChannels.clear();
        this.printerReports.clear();
        this.recentReplies = [];
        this.agentId = agent;
        this.agentKey = key;
        return { agent, handshake: this.handshake };
    }
    /**
     * Send one MQTT command to a printer through Bambu's network plugin over the cloud, as Bambu Studio does.
     * Firmware 01.08.05+ refuses unsigned LAN MQTT control outside LAN Only + Developer Mode; the plugin's cloud
     * path is signed. The plugin needs the cloud connection and a subscription to the printer first: sending
     * without them crashes it (pthread_mutex_lock in bambu_network_send_message). Returns the plugin's result (0 = ok).
     */
    async sendPrinterMessage(devId, messageJson, options = {}) {
        await this.ensurePrinterChannel(devId, options);
        let code = -2;
        // -2 (CONNECT_FAILED) right after subscribing means the channel is still settling: retry briefly.
        for (let attempt = 0; attempt < 4 && code === -2; attempt++) {
            if (attempt)
                await new Promise(resolve => setTimeout(resolve, 2000));
            const response = await this.callWithAgent("net.send_message", { dev_id: devId, msg: messageJson, qos: options.qos ?? 1, flag: 0 }, options);
            assertBridgeOk(response, "net.send_message");
            code = bridgeValueAsNumber(response, "net.send_message");
        }
        if (code !== 0)
            throw new Error(`Bambu's network plugin refused the printer command (send_message returned ${code}).`);
        return code;
    }
    /**
     * sendPrinterMessage, then wait (at most `replyMs`, default BAMBU_COMMAND_REPLY_MS) for the printer's reply to
     * the command's sequence_id, which the plugin hands back as an on_message (cloud) or on_local_message (LAN)
     * event, as Bambu Studio matches its command acks. A refusal (result "fail", a non-zero err_code) throws; no reply
     * within the wait is not an error. `waitedMs` is 0 when nothing was awaited.
     */
    async sendPrinterCommand(devId, messageJson, options = {}) {
        const sequenceId = commandSequenceId(messageJson);
        const waitMs = options.replyMs ?? commandReplyWaitMs();
        if (!sequenceId || waitMs <= 0)
            return { code: await this.sendPrinterMessage(devId, messageJson, options), waitedMs: 0 };
        await this.ensurePrinterChannel(devId, options);
        // The host queues every plugin event until it is polled; skip the backlog so the reply turns up within the wait.
        await this.drainEvents(options);
        const code = await this.sendPrinterMessage(devId, messageJson, options);
        const reply = await this.awaitPrinterReply(devId, sequenceId, waitMs, options);
        assertCommandAccepted(reply);
        return { code, reply, waitedMs: reply ? 0 : waitMs };
    }
    async pollEvents(options, limit = 1024) {
        const polled = await this.request("bridge.poll_events", { limit }, options);
        return this.ingestEvents(Array.isArray(polled?.events) ? polled.events : []);
    }
    /**
     * Every printer message the plugin hands back (on_message from the cloud, on_local_message from its LAN session)
     * updates that printer's restored state, as Studio's DeviceManager does with the same callbacks; command replies
     * are kept for a minute for reply matching.
     */
    ingestEvents(events) {
        const now = Date.now();
        for (const event of events) {
            if (event.name !== "on_message" && event.name !== "on_local_message")
                continue;
            const devId = typeof event.payload?.dev_id === "string" ? event.payload.dev_id : undefined;
            let message;
            try {
                message = JSON.parse(String(event.payload?.msg ?? ""));
            }
            catch {
                continue;
            }
            if (devId && this.printerReport(devId).ingest(message, now) !== undefined)
                continue;
            this.recentReplies.push({ devId, at: now, message });
        }
        this.recentReplies = this.recentReplies.filter(entry => now - entry.at <= 60000).slice(-256);
        return events;
    }
    /** The printer's state as restored from the plugin's pushes (empty until a full report arrives through it). */
    printerReport(devId) {
        let report = this.printerReports.get(devId);
        if (!report) {
            report = new PrinterReport();
            this.printerReports.set(devId, report);
        }
        return report;
    }
    /**
     * The printer's answer to a print the plugin sent (`project_file` with a result), received at or after `since`.
     * The plugin numbers that command itself, so like Bambu Studio (DeviceManager.cpp "project_file") any project_file
     * answer from this printer counts.
     */
    async projectFileReply(devId, since, options = {}) {
        try {
            await this.pollEvents(options);
        }
        catch { /* use what has arrived */ }
        for (const entry of this.recentReplies) {
            if (entry.at < since || (entry.devId !== undefined && entry.devId !== devId))
                continue;
            const print = entry.message?.print;
            if (!print || print.command !== "project_file" || print.sequence_id === undefined)
                continue;
            const reply = matchCommandReply(entry.message, String(print.sequence_id));
            if (reply)
                return reply;
        }
        return undefined;
    }
    async drainEvents(options) {
        try {
            for (let round = 0; round < 50; round++) {
                if ((await this.pollEvents(options)).length < 1024)
                    return;
            }
        }
        catch { /* best effort: a reply may then take longer to find */ }
    }
    /** The printer's reply to `sequenceId` among the plugin's message events, polled until `waitMs` runs out. */
    async awaitPrinterReply(devId, sequenceId, waitMs, options = {}) {
        const deadline = Date.now() + waitMs;
        while (true) {
            try {
                await this.pollEvents(options);
            }
            catch {
                return undefined;
            }
            for (const entry of this.recentReplies) {
                if (entry.devId !== undefined && entry.devId !== devId)
                    continue;
                const reply = matchCommandReply(entry.message, sequenceId);
                if (reply)
                    return reply;
            }
            const left = deadline - Date.now();
            if (left <= 0)
                return undefined;
            await new Promise(resolve => setTimeout(resolve, Math.min(250, left)));
        }
    }
    /**
     * Open the cloud channel to a printer as Bambu Studio does, once per agent: sign-in check, cloud connection,
     * callbacks, machine selection, subscription, the printer's first messages, then the certificates the plugin
     * signs with. Cloud prints need it too: without it start_print fails with -3140 (ENC_FLAG_NOT_READY).
     */
    async ensurePrinterChannel(devId, options = {}) {
        if (!devId.trim())
            throw new Error("A printer dev_id is required for BambuNetwork control.");
        const login = await this.callWithAgent("net.is_user_login", {}, options);
        if (login?.value !== true) {
            throw new Error("The BambuNetwork bridge is not signed in to a Bambu account. Copy a signed-in Bambu Studio's BambuNetworkEngine.conf into the bridge config directory, or pass user_info.");
        }
        let connected = false;
        for (let attempt = 0; attempt < 20 && !connected; attempt++) {
            const status = await this.callWithAgent("net.is_server_connected", {}, options);
            connected = status?.value === true;
            if (!connected)
                await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (!connected)
            throw new Error("The BambuNetwork bridge did not connect to Bambu's cloud within 20 seconds; nothing was sent.");
        if (!this.subscribedDevices.has(devId)) {
            // Studio's DeviceManager order: register the plugin callbacks, select the machine, subscribe, then wait for
            // on_printer_connected. Without the callbacks and selection, send_message returns -2 (CONNECT_FAILED).
            for (const fn of ["set_on_server_connected_fn", "set_on_printer_connected_fn", "set_on_subscribe_failure_fn", "set_on_message_fn"]) {
                assertBridgeOk(await this.callWithAgent(`net.${fn}`, {}, options), `net.${fn}`);
            }
            assertBridgeOk(await this.callWithAgent("net.set_user_selected_machine", { dev_id: devId }, options), "net.set_user_selected_machine");
            assertBridgeOk(await this.callWithAgent("net.start_subscribe", { module: "app" }, options), "net.start_subscribe");
            assertBridgeOk(await this.callWithAgent("net.add_subscribe", { devs: [devId] }, options), "net.add_subscribe");
            let printerConnected = false;
            for (let attempt = 0; attempt < 30 && !printerConnected; attempt++) {
                const polled = await this.request("bridge.poll_events", { limit: 256 }, options);
                for (const event of this.ingestEvents(polled?.events ?? [])) {
                    if (event.name === "on_subscribe_failure")
                        throw new Error(`Bambu's cloud refused the subscription to printer ${devId}; is it bound to the signed-in account?`);
                    // on_printer_connected comes first, but send_message only works once the printer's own messages flow.
                    if (event.name === "on_message" && event.payload?.dev_id === devId)
                        printerConnected = true;
                }
                if (!printerConnected)
                    await new Promise(resolve => setTimeout(resolve, 500));
            }
            if (!printerConnected)
                throw new Error(`Bambu's cloud did not connect to printer ${devId} within 15 seconds; nothing was sent.`);
            // Firmware 01.08.05+ only takes signed `print`-section commands (pause, resume, stop, clean_print_error, ...).
            // The plugin signs them once it holds the account's certificate (update_cert) and the printer's
            // (install_device_cert, as Studio does on connect); before that send_message refuses them with -2.
            // Studio's on-connect sequence (GUI_App.cpp): request a full push and the version first; the plugin uses the
            // printer's replies when it installs the device certificate.
            for (const hello of [{ pushing: { command: "pushall", sequence_id: nextSequenceId(), version: 1, push_target: 1 } }, { info: { command: "get_version", sequence_id: nextSequenceId() } }]) {
                assertBridgeOk(await this.callWithAgent("net.send_message", { dev_id: devId, msg: JSON.stringify(hello), qos: 0, flag: 0 }, options), "net.send_message");
            }
            assertBridgeOk(await this.callWithAgent("net.update_cert", {}, options), "net.update_cert");
            await new Promise(resolve => setTimeout(resolve, 3000));
            assertBridgeOk(await this.callWithAgent("net.install_device_cert", { dev_id: devId, lan_only: false }, options), "net.install_device_cert");
            await new Promise(resolve => setTimeout(resolve, 3000));
            this.subscribedDevices.add(devId);
        }
    }
    /**
     * Open the plugin's own LAN MQTT session to a printer the way Bambu Studio does before a LAN print
     * (MachineObject::connect, GUI_App's on_local_connect / on_printer_connected handlers): callbacks, connect_printer
     * as bblp with the access code over TLS, wait for on_local_connect, request a full push and the version, wait
     * until the printer's own report arrives on that session (the plugin reads its signing flag from it), then
     * install the device certificate. Without it start_local_print has no session to publish on (-4030) and nothing
     * to sign with. Once per agent and printer address.
     */
    async ensureLocalChannel(devId, devIp, accessCode, options = {}) {
        if (!devId.trim())
            throw new Error("A printer dev_id is required for a BambuNetwork LAN connection.");
        if (!devIp.trim() || !accessCode.trim())
            throw new Error("A printer address and LAN access code are required for a BambuNetwork LAN connection.");
        const key = `${devId}\n${devIp}`;
        if (this.localChannels.has(key))
            return;
        const lanOnly = options.lanOnly ?? true;
        for (const fn of ["set_on_local_connect_fn", "set_on_local_message_fn", "set_on_printer_connected_fn"]) {
            assertBridgeOk(await this.callWithAgent(`net.${fn}`, {}, options), `net.${fn}`);
        }
        assertBridgeOk(await this.callWithAgent("net.update_cert", {}, options), "net.update_cert");
        const connect = await this.callWithAgent("net.connect_printer", { dev_id: devId, dev_ip: devIp, username: "bblp", password: accessCode, use_ssl: true }, options);
        assertBridgeOk(connect, "net.connect_printer");
        const connectCode = bridgeValueAsNumber(connect, "net.connect_printer");
        if (connectCode !== 0)
            throw new Error(`Bambu's network plugin could not start a LAN connection to printer ${devId} (connect_printer returned ${connectCode}); nothing was sent.`);
        const poll = async () => this.ingestEvents((await this.request("bridge.poll_events", { limit: 256 }, options))?.events ?? []);
        const forPrinter = (payload) => !payload?.dev_id || payload.dev_id === devId;
        let connected = false;
        // connect_printer only starts the MQTT loop: publishing before on_local_connect races the CONNACK (-4030).
        for (let attempt = 0; attempt < 20 && !connected; attempt++) {
            for (const event of await poll()) {
                if (event.name !== "on_local_connect" || !forPrinter(event.payload))
                    continue;
                const status = Number(event.payload?.status);
                if (status === 0) {
                    connected = true;
                    continue;
                }
                const message = String(event.payload?.msg ?? "");
                throw new Error(message === "5"
                    ? `Printer ${devId} refused the LAN access code (Bambu Studio: "Incorrect password"); nothing was sent.`
                    : `Bambu's network plugin could not connect to printer ${devId} over LAN (status ${status}${message ? `, code ${message}` : ""}); nothing was sent.`);
            }
            if (!connected)
                await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (!connected)
            throw new Error(`Bambu's network plugin did not connect to printer ${devId} at ${devIp} over LAN within 10 seconds; nothing was sent.`);
        // Studio's on-connect requests (GUI_App.cpp on_local_connect): a full push and the version.
        for (const hello of [{ pushing: { command: "pushall", sequence_id: nextSequenceId(), version: 1, push_target: 1 } }, { info: { command: "get_version", sequence_id: nextSequenceId() } }]) {
            assertBridgeOk(await this.callWithAgent("net.send_message_to_printer", { dev_id: devId, msg: JSON.stringify(hello), qos: 0, flag: 0 }, options), "net.send_message_to_printer");
        }
        let reported = false;
        for (let attempt = 0; attempt < 20 && !reported; attempt++) {
            for (const event of await poll()) {
                if (event.name !== "on_local_message" || !forPrinter(event.payload))
                    continue;
                if (String(event.payload?.msg ?? "").includes("push_status"))
                    reported = true;
            }
            if (!reported)
                await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (!reported)
            throw new Error(`Printer ${devId} sent no status report on the plugin's LAN session within 10 seconds, so the plugin can't sign for it; nothing was sent.`);
        assertBridgeOk(await this.callWithAgent("net.install_device_cert", { dev_id: devId, lan_only: lanOnly }, options), "net.install_device_cert");
        await new Promise(resolve => setTimeout(resolve, 3000));
        this.localChannels.add(key);
    }
    async callWithAgent(method, payload = {}, options = {}) {
        const { agent } = await this.ensureAgent(options);
        return await this.request(method, { ...payload, agent }, options);
    }
    async stop() {
        const child = this.child;
        this.child = undefined;
        this.commandLine = undefined;
        this.agentId = undefined;
        this.agentKey = undefined;
        this.handshake = undefined;
        this.subscribedDevices.clear();
        this.localChannels.clear();
        this.printerReports.clear();
        this.recentReplies = [];
        this.stdoutBuffer = Buffer.alloc(0);
        for (const [id, pending] of this.pending.entries()) {
            clearTimeout(pending.timer);
            rejectPending(pending, new Error(`FULU BambuNetwork bridge stopped before ${pending.method} completed.`));
            this.pending.delete(id);
        }
        if (child && child.exitCode === null) {
            await new Promise((resolve) => {
                const forceTimer = setTimeout(() => {
                    if (child.exitCode === null) {
                        child.kill("SIGKILL");
                    }
                }, 2000);
                child.once("close", () => {
                    clearTimeout(forceTimer);
                    resolve();
                });
                child.kill("SIGTERM");
            });
        }
    }
    async ensureStarted(commandOverride) {
        const command = this.resolveBridgeCommand(commandOverride);
        if (!command) {
            throw new Error("BAMBU_NETWORK_BRIDGE_COMMAND is required for FULU BambuNetwork support. " +
                "Point it at pjarczak_bambu_linux_host or the OrcaSlicer-bambulab macOS/WSL wrapper.");
        }
        if (this.child && this.child.exitCode === null && this.commandLine === command) {
            return;
        }
        if (this.child && this.commandLine !== command) {
            await this.stop();
        }
        const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
        const shellArgs = process.platform === "win32"
            ? ["/d", "/s", "/c", command]
            : ["-lc", command];
        this.child = spawn(shell, shellArgs, {
            env: {
                ...process.env,
                PJARCZAK_BAMBU_COUNTRY_CODE: this.resolveCountryCode(),
                PJARCZAK_EXPECTED_BAMBU_NETWORK_VERSION: this.inferredExpectedNetworkVersion ||
                    process.env.PJARCZAK_EXPECTED_BAMBU_NETWORK_VERSION ||
                    "",
            },
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.commandLine = command;
        const spawnedChild = this.child;
        spawnedChild.stdout.on("data", (chunk) => this.handleStdout(chunk));
        spawnedChild.stderr.on("data", (chunk) => this.rememberStderr(chunk.toString("utf8")));
        spawnedChild.on("error", (error) => {
            if (this.child === spawnedChild) {
                this.rejectAllPending(error);
            }
        });
        spawnedChild.on("close", (code, signal) => {
            if (this.child !== spawnedChild) {
                return;
            }
            this.rejectAllPending(new Error(`FULU BambuNetwork bridge exited (code=${code ?? "null"}, signal=${signal ?? "null"}). ${this.lastStderr}`.trim()));
            this.child = undefined;
            this.commandLine = undefined;
            this.agentId = undefined;
            this.agentKey = undefined;
            this.handshake = undefined;
        });
    }
    handleStdout(chunk) {
        this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
        while (this.stdoutBuffer.length >= FRAME_HEADER_SIZE) {
            const magic = this.stdoutBuffer.readUInt32LE(0);
            if (magic !== FRAME_MAGIC) {
                const preview = this.stdoutBuffer.subarray(0, Math.min(this.stdoutBuffer.length, 120)).toString("utf8");
                this.rejectAllPending(new Error(`Invalid FULU BambuNetwork bridge frame magic. Output began with: ${preview}`));
                this.stdoutBuffer = Buffer.alloc(0);
                return;
            }
            const type = this.stdoutBuffer.readUInt32LE(4);
            const id = this.stdoutBuffer.readUInt32LE(8);
            const size = this.stdoutBuffer.readUInt32LE(12);
            if (this.stdoutBuffer.length < FRAME_HEADER_SIZE + size) {
                return;
            }
            const payload = this.stdoutBuffer.subarray(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + size);
            this.stdoutBuffer = this.stdoutBuffer.subarray(FRAME_HEADER_SIZE + size);
            if (type === FRAME_TYPE_JSON_RESPONSE) {
                this.resolvePendingJson(id, payload);
            }
            else if (type === FRAME_TYPE_LOG) {
                this.rememberLog(payload.toString("utf8"));
            }
            else if (type === FRAME_TYPE_BINARY_DATA) {
                this.rememberLog(`received ${payload.length} bytes of bridge binary data for request ${id}`);
            }
            else {
                this.rememberLog(`ignored bridge frame type ${type} for request ${id}`);
            }
        }
    }
    resolvePendingJson(id, payload) {
        const pending = this.pending.get(id);
        if (!pending) {
            this.rememberLog(`received response for unknown bridge request ${id}`);
            return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(id);
        try {
            pending.resolve(readFrameJson(payload));
        }
        catch (error) {
            pending.reject(error instanceof Error ? error : new Error(String(error)));
        }
    }
    rememberLog(message) {
        const trimmed = message.trim();
        if (!trimmed)
            return;
        this.recentLogs.push(trimmed);
        if (this.recentLogs.length > 25) {
            this.recentLogs = this.recentLogs.slice(-25);
        }
    }
    rememberStderr(message) {
        const combined = `${this.lastStderr}${message}`;
        this.lastStderr = combined.length > 4000 ? combined.slice(-4000) : combined;
    }
    rejectAllPending(error) {
        for (const [id, pending] of this.pending.entries()) {
            clearTimeout(pending.timer);
            rejectPending(pending, error);
            this.pending.delete(id);
        }
    }
    needsExpectedVersionRetry(handshake) {
        if (typeof handshake !== "object" || handshake === null) {
            return false;
        }
        const value = handshake;
        return (value.network_loaded === false &&
            typeof value.network_actual_abi_version === "string" &&
            value.network_actual_abi_version.length > 0 &&
            typeof value.network_status === "string" &&
            value.network_status.toLowerCase().includes("expected abi version"));
    }
}
