export interface ControlProtocol {
    /** Studio's is_enable_np: the report has cfg, fun, aux and stat (H2 series, P2S, X2D, X1 on current firmware). */
    np: boolean;
    /** fun bit 39 (m_support_mqtt_bet_ctrl): the bed takes set_bed_temp; otherwise M140. */
    bedJson: boolean;
    /** device.airduct present (DevFan::GetSupportAirduct): new-protocol fans take set_fan. */
    airduct: boolean;
    /** flag3 bit 9 (is_enable_ams_np): the AMS takes the new commands on older firmware. */
    amsNp: boolean;
    extruders: number;
}
export declare function controlProtocol(raw: Record<string, any> | undefined, model: string): ControlProtocol;
export interface ControlCommand {
    /** The full MQTT message (a gcode_line envelope for G-code). */
    messageJson: string;
    /** Set when the command is G-code (sent as print.gcode_line). */
    gcode?: string;
    qos: 0 | 1;
}
/**
 * Heater command. Bed: set_bed_temp where fun bit 39 says so, else M140. Nozzle: M104 S on single-extruder printers
 * (no T), set_nozzle_temp extruder_index 0 (right/main) or 1 (left/deputy) on dual-extruder ones. Chamber: set_ctt.
 */
export declare function temperatureCommand(protocol: ControlProtocol, heater: "bed" | "nozzle" | "chamber", target: number, extruder?: number): ControlCommand;
/** Fan ids as Studio numbers them (AIR_FUN): 1 part cooling, 2 auxiliary, 3 chamber, 10 right auxiliary. */
export declare function fanId(fan: string | number): 1 | 2 | 3 | 10;
/**
 * FanControlNew::command_control_fan: Studio sets fans in 10 % steps. Without the new protocol or an airduct it sends
 * M106 P<fan> S<floor(step * 25.5)>; with both, set_fan fan_index <fan> speed <step * 10>.
 */
export declare function fanCommand(protocol: ControlProtocol, fan: string | number, percent: number): ControlCommand & {
    fanIndex: number;
    speed: number;
};
/** RFID re-read: ams_get_rfid on new-protocol printers (or new AMS protocol), else M620 R<ams * 4 + slot>. */
export declare function rfidCommand(protocol: ControlProtocol, amsId: number, slotId: number): ControlCommand;
/**
 * Studio refuses an RFID read while filament is loaded to the toolhead the AMS feeds ("Cannot read filament info: the
 * filament is loaded to the toolhead, please unload the filament and try again"): on new-protocol printers from the
 * extruder's info bit 1, else from hw_switch_state (anything but 0 counts as loaded, as in is_filament_at_extruder).
 */
export declare function assertNoFilamentAtToolhead(raw: Record<string, any>, protocol: ControlProtocol, model: string, amsId: number): void;
