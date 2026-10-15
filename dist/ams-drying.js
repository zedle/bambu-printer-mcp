import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
const AMS_TYPE_NAMES = { 0: "none", 1: "AMS", 2: "AMS lite", 3: "AMS 2 Pro", 4: "AMS HT", 5: "AMS lite" };
const DRYING_TYPES = {
    3: { name: "AMS 2 Pro", maxTemperature: 65 },
    4: { name: "AMS HT", maxTemperature: 85 },
};
/** DevAms::CannotDryReason, as the printer lists them in `dry_sf_reason`. */
const CANNOT_DRY_REASONS = {
    0: "a task is using the AMS",
    1: "insufficient power",
    2: "the AMS is busy",
    3: "filament is at the AMS outlet",
    4: "AMS drying is initialising",
    5: "not supported in 2D mode",
    6: "drying is already in progress",
    7: "the printer is upgrading",
    8: "insufficient power: connect the AMS power adapter",
    10: "filament is at the AMS outlet: unload it by hand",
};
/** Studio's DevUtil::get_flag_bits_no_border: bit `bit` of a hex string of any length. */
export function hexFlagBit(value, bit) {
    if (typeof value !== "string")
        return false;
    const hex = value.trim().replace(/^0x/i, "").replace(/[^0-9a-f]/gi, "");
    if (!hex)
        return false;
    const nibbleIndex = hex.length - 1 - Math.floor(bit / 4);
    if (nibbleIndex < 0)
        return false;
    return ((parseInt(hex[nibbleIndex], 16) >> (bit % 4)) & 1) === 1;
}
export function normalizeAmsDryingRequest(args) {
    const action = String(args.action ?? "").trim().toLowerCase();
    if (action !== "start" && action !== "stop")
        throw new Error("AMS drying action must be one of: start, stop.");
    const amsId = Number(args.ams_id);
    if (!Number.isInteger(amsId) || !((amsId >= 0 && amsId <= 3) || (amsId >= 128 && amsId <= 135))) {
        throw new Error("ams_id must be an integer AMS unit id: 0 to 3, or 128 to 135 for an AMS HT.");
    }
    if (action === "stop")
        return { action, amsId };
    const filament = typeof args.filament === "string" ? args.filament.trim() : "";
    if (!filament || filament.length > 32 || !/^[A-Za-z0-9+\-_. ]+$/.test(filament)) {
        throw new Error("Starting AMS drying requires filament: the filament type being dried, e.g. PLA, PETG, ABS or PA.");
    }
    const integer = (key, label, min, max) => {
        const value = args[key];
        if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
            throw new Error(`Starting AMS drying requires ${key}: ${label}, an integer from ${min} to ${max}.`);
        }
        return value;
    };
    const temperature = integer("temperature", "the drying temperature in °C", 1, 85);
    const durationHours = integer("duration_hours", "the drying time in hours", 1, 24);
    if (args.rotate_tray !== undefined && typeof args.rotate_tray !== "boolean")
        throw new Error("rotate_tray must be a boolean.");
    const coolingTemperature = args.cooling_temperature === undefined
        ? studioDryingCoolingTemperature(filament)
        : integer("cooling_temperature", "the filament's cooling temperature in °C", 0, 200);
    if (coolingTemperature === undefined) {
        throw new Error(`No Bambu Studio drying preset was found for ${filament}; pass cooling_temperature (Studio's filament_dev_drying_cooling_temperature for that filament).`);
    }
    return { action, amsId, filament, temperature, durationHours, rotateTray: args.rotate_tray === true, coolingTemperature };
}
/**
 * Refuse a drying start the printer would not take: no remote drying (`fun2` bit 5), an AMS unit it doesn't report,
 * a unit that can't dry, a temperature over the unit's limit, or reasons the printer itself lists in `dry_sf_reason`.
 * Stop is never refused (like heater-off).
 */
export function assertAmsDryingSupported(raw, request) {
    if (request.action === "stop")
        return;
    if (!raw || typeof raw !== "object")
        throw new Error("AMS drying needs a fresh printer report; none was received, so nothing was sent.");
    if (!hexFlagBit(raw.fun2, 5)) {
        throw new Error("This printer does not report remote AMS drying (push_status fun2 bit 5), so Bambu Studio would not offer it either; nothing was sent.");
    }
    const units = Array.isArray(raw.ams?.ams) ? raw.ams.ams : [];
    const unit = units.find(entry => Number(entry?.id) === request.amsId);
    if (!unit)
        throw new Error(`The printer reports no AMS unit ${request.amsId}; nothing was sent.`);
    const type = typeof unit.info === "string" ? parseInt(unit.info.slice(-1), 16) : NaN;
    const dryer = DRYING_TYPES[type];
    if (!dryer) {
        throw new Error(`AMS unit ${request.amsId} is ${Number.isNaN(type) ? "of unknown type" : `an ${AMS_TYPE_NAMES[type] ?? `type ${type}`} unit`}, which can't dry filament (only AMS 2 Pro and AMS HT can); nothing was sent.`);
    }
    if ((request.temperature ?? 0) > dryer.maxTemperature) {
        throw new Error(`${dryer.name} dries at up to ${dryer.maxTemperature} °C; ${request.temperature} °C was refused before sending.`);
    }
    const reasons = Array.isArray(unit.dry_sf_reason) ? unit.dry_sf_reason : [];
    if (reasons.length) {
        const text = reasons.map(reason => CANNOT_DRY_REASONS[Number(reason)] ?? `reason ${String(reason)}`).join("; ");
        throw new Error(`The printer says AMS unit ${request.amsId} can't dry now: ${text}. Nothing was sent.`);
    }
}
/** The exact print envelope Studio publishes, key for key. */
export function buildAmsDryingCommand(request, sequenceId) {
    const start = request.action === "start";
    return {
        print: {
            command: "ams_filament_drying",
            sequence_id: sequenceId,
            ams_id: request.amsId,
            mode: start ? 1 : 0,
            filament: start ? request.filament : "",
            temp: start ? request.temperature : 0,
            duration: start ? request.durationHours : 0,
            humidity: 0,
            rotate_tray: start ? request.rotateTray === true : false,
            cooling_temp: start ? request.coolingTemperature : 0,
            close_power_conflict: false,
        },
    };
}
/**
 * Bambu Studio's `filament_dev_drying_cooling_temperature` for a filament type, from its bundled BBL filament
 * presets (fdm_filament_<type>.json and what it inherits). Undefined when no Studio profile tree is installed.
 */
export function studioDryingCoolingTemperature(filament, profilesRoot = process.env.BAMBU_PROFILES_ROOT) {
    if (!profilesRoot)
        return undefined;
    const dir = path.join(profilesRoot, "BBL", "filament");
    let name = `fdm_filament_${filament.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
    for (let depth = 0; name && depth < 8; depth++) {
        const file = path.join(dir, `${name}.json`);
        if (!existsSync(file))
            return undefined;
        let preset;
        try {
            preset = JSON.parse(readFileSync(file, "utf8"));
        }
        catch {
            return undefined;
        }
        const value = preset?.filament_dev_drying_cooling_temperature;
        const first = Array.isArray(value) ? value[0] : value;
        if (first !== undefined) {
            const number = Math.round(Number(first));
            return Number.isFinite(number) && number >= 0 && number <= 200 ? number : undefined;
        }
        name = typeof preset?.inherits === "string" && /^[\w @.+-]+$/.test(preset.inherits) ? preset.inherits : undefined;
    }
    return undefined;
}
