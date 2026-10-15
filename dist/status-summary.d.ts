/**
 * The parts of a printer report an agent needs to decide what to do next, without the full report
 * (~40k tokens on an H2C, most of it module lists and fan/airduct internals). `get_printer_status`
 * returns this as `details`; `include_raw: true` adds the report itself.
 */
/** One HMS entry ({attr, code} in the report) as Bambu's AAAA-AAAA-CCCC-CCCC form. */
export declare function hmsCode(entry: {
    attr?: unknown;
    code?: unknown;
}): string;
/** print_error as Bambu's XXXX-XXXX form, or null when there is none. */
export declare function printErrorCode(value: unknown): string | null;
export declare function statusDetails(data: Record<string, any>): Record<string, unknown>;
