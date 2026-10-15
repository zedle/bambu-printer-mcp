/**
 * AMS filament drying the way Bambu Studio sends it (DevFilaSystemCtrl.cpp CtrlAmsStartDryingHour /
 * CtrlAmsStopDrying): `ams_filament_drying` with mode 1 (on, timed) or 0 (off). Studio offers it only when the
 * printer reports remote drying (push_status `fun2` bit 5, DeviceManager.cpp is_support_remote_dry) and the unit
 * can dry (DevAms::SupportDrying: AMS 2 Pro "N3F" = type 3, AMS HT "N3S" = type 4, from the low nibble of the
 * unit's `info`).
 */
export type AmsDryingAction = "start" | "stop";
export type AmsDryingRequest = {
    action: AmsDryingAction;
    amsId: number;
    filament?: string;
    temperature?: number;
    durationHours?: number;
    rotateTray?: boolean;
    coolingTemperature?: number;
};
/** Studio's DevUtil::get_flag_bits_no_border: bit `bit` of a hex string of any length. */
export declare function hexFlagBit(value: unknown, bit: number): boolean;
export declare function normalizeAmsDryingRequest(args: Record<string, unknown>): AmsDryingRequest;
/**
 * Refuse a drying start the printer would not take: no remote drying (`fun2` bit 5), an AMS unit it doesn't report,
 * a unit that can't dry, a temperature over the unit's limit, or reasons the printer itself lists in `dry_sf_reason`.
 * Stop is never refused (like heater-off).
 */
export declare function assertAmsDryingSupported(raw: Record<string, any> | undefined, request: AmsDryingRequest): void;
/** The exact print envelope Studio publishes, key for key. */
export declare function buildAmsDryingCommand(request: AmsDryingRequest, sequenceId: string): Record<string, unknown>;
/**
 * Bambu Studio's `filament_dev_drying_cooling_temperature` for a filament type, from its bundled BBL filament
 * presets (fdm_filament_<type>.json and what it inherits). Undefined when no Studio profile tree is installed.
 */
export declare function studioDryingCoolingTemperature(filament: string, profilesRoot?: string | undefined): number | undefined;
