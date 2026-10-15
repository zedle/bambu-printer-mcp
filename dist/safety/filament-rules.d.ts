/**
 * Bambu Studio's filament prohibitions (resources/printers/filaments_blacklist.json, action "prohibition"), applied
 * like DevFilaBlacklist::check_filaments_in_blacklist before a print is sent. Warnings from that file are not ported.
 * Matching is case-insensitive: type is the filament type (tray_type, else the sliced filament_type), name the preset
 * name (filament_settings_id without " @..."), id the Bambu filament id (tray_info_idx or the file's filament_ids).
 */
/** Studio model_id (printer_type) per model. */
export declare const STUDIO_MODEL_IDS: Readonly<Record<string, string[]>>;
export interface FilamentCheck {
    model: string;
    external: boolean;
    type?: string;
    name?: string;
    filamentId?: string;
    nozzleFlow?: string;
    nozzleDiameter?: number;
    /** "auto_pa" when the job's flow calibration is automatic. */
    calibMode?: string;
}
/** The first Studio prohibition the filament hits, or undefined. */
export declare function filamentProhibition(check: FilamentCheck): string | undefined;
