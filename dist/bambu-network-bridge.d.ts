type JsonObject = Record<string, unknown>;
export type BambuNetworkBridgeOptions = {
    bridgeCommand?: string;
    configDir?: string;
    countryCode?: string;
    userInfo?: string;
    timeoutMs?: number;
    /** Trusted in-process preflight; never populated from tool arguments. */
    beforeDispatch?: (method: string) => Promise<void>;
    assertDispatchAllowed?: (method: string) => void;
    onDispatched?: (method: string) => void;
};
export type BambuNetworkBridgeStatus = {
    configured: boolean;
    command: string;
    platform: NodeJS.Platform;
    running: boolean;
    pid?: number;
    configDir: string;
    countryCode: string;
    agentReady: boolean;
    lastStderr: string;
    recentLogs: string[];
    runtime: {
        macosRuntimeDir: string;
        macosRuntimeDirExists: boolean;
        macosPluginDir?: string;
        macosPluginDirExists?: boolean;
        macosMissingRuntimeFiles: string[];
        macosMissingPluginFiles: string[];
        suggestedMacCommand?: string;
    };
    note?: string;
};
export declare function defaultBambuNetworkConfigDir(): string;
export declare class BambuNetworkBridge {
    private child?;
    private commandLine?;
    private stdoutBuffer;
    private pending;
    private nextRequestId;
    private agentId?;
    private agentKey?;
    private handshake?;
    private lastStderr;
    private recentLogs;
    private inferredExpectedNetworkVersion?;
    private subscribedDevices;
    private localChannels;
    resolveBridgeCommand(override?: string): string;
    resolveConfigDir(override?: string): string;
    resolveCountryCode(override?: string): string;
    getStatus(options?: BambuNetworkBridgeOptions): BambuNetworkBridgeStatus;
    request(method: string, payload?: JsonObject, options?: BambuNetworkBridgeOptions): Promise<unknown>;
    ensureAgent(options?: BambuNetworkBridgeOptions): Promise<{
        agent: number;
        handshake: unknown;
    }>;
    /**
     * Send one MQTT command to a printer through Bambu's network plugin over the cloud, as Bambu Studio does.
     * Firmware 01.08.05+ refuses unsigned LAN MQTT control outside LAN Only + Developer Mode; the plugin's cloud
     * path is signed. The plugin needs the cloud connection and a subscription to the printer first: sending
     * without them crashes it (pthread_mutex_lock in bambu_network_send_message). Returns the plugin's result (0 = ok).
     */
    sendPrinterMessage(devId: string, messageJson: string, options?: BambuNetworkBridgeOptions & {
        qos?: number;
    }): Promise<number>;
    /**
     * Open the cloud channel to a printer as Bambu Studio does, once per agent: sign-in check, cloud connection,
     * callbacks, machine selection, subscription, the printer's first messages, then the certificates the plugin
     * signs with. Cloud prints need it too: without it start_print fails with -3140 (ENC_FLAG_NOT_READY).
     */
    ensurePrinterChannel(devId: string, options?: BambuNetworkBridgeOptions): Promise<void>;
    /**
     * Open the plugin's own LAN MQTT session to a printer the way Bambu Studio does before a LAN print
     * (MachineObject::connect, GUI_App's on_local_connect / on_printer_connected handlers): callbacks, connect_printer
     * as bblp with the access code over TLS, wait for on_local_connect, request a full push and the version, wait
     * until the printer's own report arrives on that session (the plugin reads its signing flag from it), then
     * install the device certificate. Without it start_local_print has no session to publish on (-4030) and nothing
     * to sign with. Once per agent and printer address.
     */
    ensureLocalChannel(devId: string, devIp: string, accessCode: string, options?: BambuNetworkBridgeOptions & {
        lanOnly?: boolean;
    }): Promise<void>;
    callWithAgent(method: string, payload?: JsonObject, options?: BambuNetworkBridgeOptions): Promise<unknown>;
    stop(): Promise<void>;
    private ensureStarted;
    private handleStdout;
    private resolvePendingJson;
    private rememberLog;
    private rememberStderr;
    private rejectAllPending;
    private needsExpectedVersionRetry;
}
export {};
