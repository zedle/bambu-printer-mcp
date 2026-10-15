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
