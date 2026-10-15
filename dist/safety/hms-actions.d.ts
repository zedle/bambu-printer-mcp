/** Where Bambu Studio keeps its downloaded HMS files (BAMBU_HMS_DIR overrides). */
export declare function hmsDirectories(): string[];
/** The dialog's action buttons for a print_error on the printer with this serial, or undefined when unknown. */
export declare function printErrorActions(serial: string, printError: number): number[] | undefined;
/** Whether Studio's dialog offers Resume for this print_error. */
export declare function printErrorResumable(serial: string, printError: number): boolean;
