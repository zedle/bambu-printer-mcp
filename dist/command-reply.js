/**
 * Replies to the commands this server sends. A Bambu printer answers a command on its report topic (and over the
 * cloud) with the command's own sequence_id plus `result` / `reason`, and `err_code` on newer firmware. Bambu Studio
 * matches those replies to its own commands by sequence_id (DeviceManager.cpp parse_json: err_code acks become
 * error dialogs, a project_file `result: "fail"` is "Failed to start printing job"). Every command this server sends
 * carries an id from its own range (sequence-id.ts), so its replies can be told apart from Studio's and the cloud's.
 */
const DEFAULT_REPLY_WAIT_MS = 3000;
/** How long to wait for a command's reply (BAMBU_COMMAND_REPLY_MS, 0 disables, at most 30 s). */
export function commandReplyWaitMs() {
    const raw = process.env.BAMBU_COMMAND_REPLY_MS?.trim();
    if (!raw)
        return DEFAULT_REPLY_WAIT_MS;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 && value <= 30000 ? value : DEFAULT_REPLY_WAIT_MS;
}
/** The sequence_id of an outgoing command (its single top-level section), if it has one. */
export function commandSequenceId(message) {
    const parsed = typeof message === "string" ? (() => { try {
        return JSON.parse(message);
    }
    catch {
        return undefined;
    } })() : message;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return undefined;
    for (const body of Object.values(parsed)) {
        if (body && typeof body === "object" && !Array.isArray(body)) {
            const id = body.sequence_id;
            if (typeof id === "string" || typeof id === "number")
                return String(id);
        }
    }
    return undefined;
}
/**
 * The reply to the command numbered `sequenceId` in a printer message (an object or its JSON), if this is one.
 * Status pushes carry the printer's own counter as sequence_id, so they never count; neither does a message with
 * the id but no outcome (an echo of the request).
 */
export function matchCommandReply(message, sequenceId) {
    let parsed = message;
    if (typeof message === "string" || Buffer.isBuffer(message)) {
        try {
            parsed = JSON.parse(String(message));
        }
        catch {
            return undefined;
        }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return undefined;
    for (const [section, body] of Object.entries(parsed)) {
        if (!body || typeof body !== "object" || Array.isArray(body))
            continue;
        const reply = body;
        if (reply.command === "push_status" || reply.sequence_id === undefined || String(reply.sequence_id) !== sequenceId)
            continue;
        if (reply.result === undefined && reply.reason === undefined && reply.err_code === undefined)
            continue;
        const errCode = typeof reply.err_code === "number" ? reply.err_code
            : typeof reply.err_code === "string" && /^-?\d+$/.test(reply.err_code.trim()) ? Number(reply.err_code) : undefined;
        return {
            section,
            ...(typeof reply.command === "string" ? { command: reply.command } : {}),
            ...(reply.result !== undefined ? { result: String(reply.result) } : {}),
            ...(reply.reason !== undefined ? { reason: String(reply.reason) } : {}),
            ...(errCode !== undefined ? { errCode } : {}),
        };
    }
    return undefined;
}
/** Why the printer refused the command, or undefined when the reply doesn't say it failed. */
export function commandReplyFailure(reply) {
    if (!reply)
        return undefined;
    const result = (reply.result ?? "").trim().toLowerCase();
    const failed = ["fail", "failed", "error"].includes(result) || (reply.errCode !== undefined && reply.errCode !== 0);
    if (!failed)
        return undefined;
    const code = reply.errCode !== undefined && reply.errCode !== 0
        ? ` (error ${(reply.errCode >>> 0).toString(16).toUpperCase().padStart(8, "0")})` : "";
    const why = reply.reason && reply.reason.toLowerCase() !== result ? `: ${reply.reason}` : "";
    return `The printer refused ${reply.command ?? "the command"}${why}${code}.`;
}
/** Throw the printer's refusal, if the reply is one. */
export function assertCommandAccepted(reply) {
    const failure = commandReplyFailure(reply);
    if (failure)
        throw new Error(failure);
}
/** The printer's reply as a tool result field. */
export function printerReplyField(reply) {
    return {
        ...(reply.result !== undefined ? { result: reply.result } : {}),
        ...(reply.reason !== undefined ? { reason: reply.reason } : {}),
        ...(reply.errCode !== undefined ? { err_code: reply.errCode } : {}),
    };
}
/** The sentence a result's message ends with: what the printer replied, or that it didn't within the wait. */
export function printerReplyNote(field, waitedMs) {
    if (field) {
        const said = [field.result, field.reason && field.reason !== field.result ? field.reason : undefined].filter(Boolean).join(", ");
        return ` The printer replied${said ? `: ${said}` : ""}.`;
    }
    if (field === null && waitedMs > 0) {
        return ` The printer sent no reply within ${waitedMs / 1000} s; check get_printer_status to see whether it took effect.`;
    }
    return "";
}
/**
 * Add the printer's reply to a command result: `printerReply` (its result / reason / err_code; null when it sent
 * none within the wait) and a sentence after `message`. `waitedMs` 0 means no reply could be awaited (nothing added).
 */
export function withCommandReply(result, reply, waitedMs) {
    if (!reply && waitedMs <= 0)
        return result;
    return withPrinterReplyField(result, reply ? printerReplyField(reply) : null, waitedMs);
}
/** The same for a reply field another route already produced (a signed command's result). */
export function withPrinterReplyField(result, field, waitedMs = commandReplyWaitMs()) {
    if (field === undefined)
        return result;
    const note = printerReplyNote(field, waitedMs);
    return {
        ...result,
        ...(typeof result.message === "string" && note ? { message: result.message + note } : {}),
        printerReply: field,
    };
}
