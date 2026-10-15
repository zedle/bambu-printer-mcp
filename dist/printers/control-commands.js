/**
 * Printer control commands in the form Bambu Studio picks for each printer. Studio decides per printer from its
 * report, not per transport: the same message goes over LAN MQTT or through the network plug-in (signed).
 * Sources: BambuStudio DeviceManager.cpp (command_set_bed, command_set_nozzle(_new), command_ams_refresh_rfid(2),
 * publish_gcode, check_enable_np), DeviceCore/DevFan.cpp and Widgets/FanControl.cpp (fans, airduct),
 * DeviceCore/DevChamberCtrl.cpp (set_ctt), StatusPanel.cpp (which form each control uses).
 */
import { DUAL_EXTRUDER_MODELS, MAIN_EXTRUDER_ID, extruderCount } from "../safety/models.js";
/** Printers Studio talks to with the new protocol; used only when no report is at hand. */
const NP_MODELS = new Set(["h2d", "h2dpro", "h2c", "h2s", "p2s", "x2d"]);
/** Models whose recorded reports set fun bit 39 (set_bed_temp); the H2D's varies by firmware, so it gets M140. */
const BED_JSON_MODELS = new Set(["h2dpro", "h2c", "h2s", "p2s", "x2d"]);
function hexBit(value, bit) {
    if (typeof value !== "string" || !/^(?:0x)?[0-9a-f]+$/i.test(value.trim()))
        return false;
    return ((BigInt(`0x${value.trim().replace(/^0x/i, "")}`) >> BigInt(bit)) & 1n) === 1n;
}
export function controlProtocol(raw, model) {
    if (!raw || typeof raw !== "object" || Object.keys(raw).length === 0) {
        const np = NP_MODELS.has(model);
        return { np, bedJson: BED_JSON_MODELS.has(model), airduct: np, amsNp: np, extruders: extruderCount(model) };
    }
    const np = ["cfg", "fun", "aux", "stat"].every(key => raw[key] !== undefined);
    const flag3 = Number(raw.flag3);
    const info = raw.device?.extruder?.info;
    return {
        np,
        bedJson: hexBit(raw.fun, 39),
        airduct: !!raw.device?.airduct && typeof raw.device.airduct === "object",
        amsNp: Number.isInteger(flag3) && ((flag3 >>> 9) & 1) === 1,
        extruders: Array.isArray(info) && info.length > 0 ? info.length : extruderCount(model),
    };
}
const seq = () => String(Date.now());
const json = (print, qos = 0) => ({ messageJson: JSON.stringify({ print: { ...print, sequence_id: seq() } }), qos });
/** Studio's publish_gcode: {"print": {"command": "gcode_line", "param": "<gcode>\n", "sequence_id"}}. */
const gcodeLine = (gcode) => ({ messageJson: JSON.stringify({ print: { command: "gcode_line", param: gcode, sequence_id: seq() } }), gcode, qos: 0 });
/**
 * Heater command. Bed: set_bed_temp where fun bit 39 says so, else M140. Nozzle: M104 S on single-extruder printers
 * (no T), set_nozzle_temp extruder_index 0 (right/main) or 1 (left/deputy) on dual-extruder ones. Chamber: set_ctt.
 */
export function temperatureCommand(protocol, heater, target, extruder) {
    if (!Number.isInteger(target) || target < 0)
        throw new Error("Temperature targets are whole degrees.");
    if (heater === "bed")
        return protocol.bedJson ? json({ command: "set_bed_temp", temp: target }) : gcodeLine(`M140 S${target}\n`);
    if (heater === "chamber")
        return json({ command: "set_ctt", ctt_val: target }, 1);
    if (protocol.extruders === 2) {
        if (extruder !== 0 && extruder !== 1)
            throw new Error("Choose the nozzle on a dual-nozzle printer: extruder left or right.");
        return json({ command: "set_nozzle_temp", extruder_index: extruder, target_temp: target }, 1);
    }
    if (extruder !== undefined && extruder !== MAIN_EXTRUDER_ID)
        throw new Error("This printer has one nozzle.");
    return gcodeLine(`M104 S${target}\n`);
}
/** Fan ids as Studio numbers them (AIR_FUN): 1 part cooling, 2 auxiliary, 3 chamber, 10 right auxiliary. */
export function fanId(fan) {
    const value = String(fan).trim().toLowerCase();
    if (["1", "part", "part_cooling"].includes(value))
        return 1;
    if (["2", "aux", "auxiliary", "left_auxiliary"].includes(value))
        return 2;
    if (["3", "chamber", "exhaust"].includes(value))
        return 3;
    if (["10", "right_aux", "right_auxiliary"].includes(value))
        return 10;
    throw new Error("Unsupported fan. Use part, auxiliary, right_auxiliary, chamber, 1, 2, 3, or 10.");
}
/**
 * FanControlNew::command_control_fan: Studio sets fans in 10 % steps. Without the new protocol or an airduct it sends
 * M106 P<fan> S<floor(step * 25.5)>; with both, set_fan fan_index <fan> speed <step * 10>.
 */
export function fanCommand(protocol, fan, percent) {
    if (!Number.isFinite(percent) || percent < 0 || percent > 100)
        throw new Error("Fan speed must be between 0 and 100 percent.");
    const id = fanId(fan);
    const step = Math.round(percent / 10);
    if (!protocol.np || !protocol.airduct) {
        if (id === 10)
            throw new Error("This printer has no right auxiliary fan.");
        return { ...gcodeLine(`M106 P${id} S${Math.floor(step * 25.5)} \n`), fanIndex: id, speed: step * 10 };
    }
    return { ...json({ command: "set_fan", fan_index: id, speed: step * 10 }), fanIndex: id, speed: step * 10 };
}
/** RFID re-read: ams_get_rfid on new-protocol printers (or new AMS protocol), else M620 R<ams * 4 + slot>. */
export function rfidCommand(protocol, amsId, slotId) {
    if (protocol.np || protocol.amsNp)
        return json({ command: "ams_get_rfid", ams_id: amsId, slot_id: slotId });
    if (amsId >= 128)
        throw new Error("This printer's firmware reads AMS-HT RFID only through the new protocol.");
    return gcodeLine(`M620 R${amsId * 4 + slotId} \n`);
}
/**
 * Studio refuses an RFID read while filament is loaded to the toolhead the AMS feeds ("Cannot read filament info: the
 * filament is loaded to the toolhead, please unload the filament and try again"): on new-protocol printers from the
 * extruder's info bit 1, else from hw_switch_state (anything but 0 counts as loaded, as in is_filament_at_extruder).
 */
export function assertNoFilamentAtToolhead(raw, protocol, model, amsId) {
    const loaded = "Cannot read filament info: the filament is loaded to the toolhead. Unload the filament and try again.";
    const extruders = raw.device?.extruder?.info;
    if ((protocol.np || protocol.amsNp) && Array.isArray(extruders) && extruders.length) {
        let bound = [MAIN_EXTRUDER_ID];
        if (DUAL_EXTRUDER_MODELS.has(model)) {
            const unit = (raw.ams?.ams ?? []).find((entry) => Number(entry?.id) === amsId);
            const id = unit?.info !== undefined && /^[0-9a-f]+$/i.test(String(unit.info)) ? Number((BigInt(`0x${unit.info}`) >> 8n) & 0xfn) : undefined;
            bound = id === undefined ? [MAIN_EXTRUDER_ID] : id === 0xe ? [0, 1] : [id];
        }
        for (const extruder of extruders) {
            if (bound.includes(Number(extruder?.id)) && Number.isInteger(Number(extruder?.info)) && ((Number(extruder.info) >>> 1) & 1) === 1)
                throw new Error(loaded);
        }
        return;
    }
    if (Number(raw.hw_switch_state) !== 0)
        throw new Error(loaded);
}
/** Airduct modes (DevFan AIR_DUCT): 0 cooling, 1 heating, 2 exhaust (Studio hides it), 3 full cooling. */
const AIRDUCT_MODES = { cooling: 0, heating: 1, full_cooling: 3 };
/**
 * set_airduct the way Studio's fan popup sends it: only on printers that report device.airduct, only modes in its
 * modeList (exhaust excluded; H2-series show the first two), with submode 1/0 for the cooling filter where given, else -1.
 */
export function airductCommand(raw, model, mode, coolingFilter) {
    const modeId = AIRDUCT_MODES[mode.trim().toLowerCase().replace(/[\s-]+/g, "_")];
    if (modeId === undefined)
        throw new Error("Airduct mode must be one of: cooling, heating, full_cooling.");
    const airduct = raw?.device?.airduct;
    if (raw && Object.keys(raw).length && (!airduct || typeof airduct !== "object"))
        throw new Error("This printer reports no switchable airduct.");
    if (airduct && Array.isArray(airduct.modeList)) {
        let offered = airduct.modeList.map((entry) => Number(entry?.modeId)).filter((id) => Number.isInteger(id) && id !== 2);
        if (["h2d", "h2dpro", "h2c", "h2s"].includes(model))
            offered = airduct.modeList.slice(0, 2).map((entry) => Number(entry?.modeId)).filter((id) => id !== 2);
        if (!offered.includes(modeId))
            throw new Error(`This printer's airduct offers ${offered.map((id) => Object.keys(AIRDUCT_MODES).find(key => AIRDUCT_MODES[key] === id) ?? id).join(", ")}, not ${mode}.`);
    }
    return { ...json({ command: "set_airduct", modeId, submode: coolingFilter === undefined ? -1 : coolingFilter ? 1 : 0 }), modeId };
}
