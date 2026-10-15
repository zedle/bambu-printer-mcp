import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const FRAME_MAGIC = 0x52424a50;
const FRAME_HEADER_SIZE = 16;
const FRAME_TYPE_JSON_REQUEST = 1;
const FRAME_TYPE_JSON_RESPONSE = 2;
const FRAME_TYPE_BINARY_DATA = 3;
const FRAME_TYPE_LOG = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
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
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Timed out waiting for FULU BambuNetwork bridge method ${method}.`));
            }, options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
            this.pending.set(id, { method, resolve, reject, timer });
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
                for (const event of polled?.events ?? []) {
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
            for (const hello of [{ pushing: { command: "pushall", sequence_id: "0", version: 1, push_target: 1 } }, { info: { command: "get_version", sequence_id: "0" } }]) {
                assertBridgeOk(await this.callWithAgent("net.send_message", { dev_id: devId, msg: JSON.stringify(hello), qos: 0, flag: 0 }, options), "net.send_message");
            }
            assertBridgeOk(await this.callWithAgent("net.update_cert", {}, options), "net.update_cert");
            await new Promise(resolve => setTimeout(resolve, 3000));
            assertBridgeOk(await this.callWithAgent("net.install_device_cert", { dev_id: devId, lan_only: false }, options), "net.install_device_cert");
            await new Promise(resolve => setTimeout(resolve, 3000));
            this.subscribedDevices.add(devId);
        }
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
        this.stdoutBuffer = Buffer.alloc(0);
        for (const [id, pending] of this.pending.entries()) {
            clearTimeout(pending.timer);
            pending.reject(new Error(`FULU BambuNetwork bridge stopped before ${pending.method} completed.`));
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
            pending.reject(error);
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
