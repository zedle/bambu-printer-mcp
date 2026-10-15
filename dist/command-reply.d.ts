/**
 * Replies to the commands this server sends. A Bambu printer answers a command on its report topic (and over the
 * cloud) with the command's own sequence_id plus `result` / `reason`, and `err_code` on newer firmware. Bambu Studio
 * matches those replies to its own commands by sequence_id (DeviceManager.cpp parse_json: err_code acks become
 * error dialogs, a project_file `result: "fail"` is "Failed to start printing job"). Every command this server sends
 * carries an id from its own range (sequence-id.ts), so its replies can be told apart from Studio's and the cloud's.
 */
export interface CommandReply {
    /** Top-level section of the reply (`print`, `system`, `info`, ...). */
    section: string;
    command?: string;
    result?: string;
    reason?: string;
    errCode?: number;
}
/** The printer's reply as tools return it. */
export interface PrinterReplyField {
    result?: string;
    reason?: string;
    err_code?: number;
}
/** How long to wait for a command's reply (BAMBU_COMMAND_REPLY_MS, 0 disables, at most 30 s). */
export declare function commandReplyWaitMs(): number;
/** The sequence_id of an outgoing command (its single top-level section), if it has one. */
export declare function commandSequenceId(message: unknown): string | undefined;
/**
 * The reply to the command numbered `sequenceId` in a printer message (an object or its JSON), if this is one.
 * Status pushes carry the printer's own counter as sequence_id, so they never count; neither does a message with
 * the id but no outcome (an echo of the request).
 */
export declare function matchCommandReply(message: unknown, sequenceId: string): CommandReply | undefined;
/** Why the printer refused the command, or undefined when the reply doesn't say it failed. */
export declare function commandReplyFailure(reply: CommandReply | undefined): string | undefined;
/** Throw the printer's refusal, if the reply is one. */
export declare function assertCommandAccepted(reply: CommandReply | undefined): void;
/** The printer's reply as a tool result field. */
export declare function printerReplyField(reply: CommandReply): PrinterReplyField;
/** The sentence a result's message ends with: what the printer replied, or that it didn't within the wait. */
export declare function printerReplyNote(field: PrinterReplyField | null | undefined, waitedMs: number): string;
/**
 * Add the printer's reply to a command result: `printerReply` (its result / reason / err_code; null when it sent
 * none within the wait) and a sentence after `message`. `waitedMs` 0 means no reply could be awaited (nothing added).
 */
export declare function withCommandReply<T extends Record<string, unknown>>(result: T, reply: CommandReply | undefined, waitedMs: number): T;
/** The same for a reply field another route already produced (a signed command's result). */
export declare function withPrinterReplyField<T extends Record<string, unknown>>(result: T, field: PrinterReplyField | null | undefined, waitedMs?: number): T;
