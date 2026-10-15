import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { matchCommandReply, commandReplyFailure, commandSequenceId } from "../dist/command-reply.js";
import { BambuImplementation } from "../dist/printers/bambu.js";
import { BambuNetworkBridge } from "../dist/bambu-network-bridge.js";

const host = "127.0.0.1", serial = "01PTEST", token = "TOKEN";

function withReplyWait(t, ms) {
  const previous = process.env.BAMBU_COMMAND_REPLY_MS;
  process.env.BAMBU_COMMAND_REPLY_MS = String(ms);
  t.after(() => { if (previous === undefined) delete process.env.BAMBU_COMMAND_REPLY_MS; else process.env.BAMBU_COMMAND_REPLY_MS = previous; });
}

// A printer client that answers each published command on its report topic, as the firmware does.
function answeringPrinter(answer) {
  const printer = new EventEmitter();
  printer.published = [];
  printer.publish = async (message) => {
    printer.published.push(message);
    const [section] = Object.keys(message);
    for (const reply of [].concat(answer(message[section], section) ?? [])) {
      setTimeout(() => printer.emit("rawMessage", `device/${serial}/report`, Buffer.from(JSON.stringify(reply))), 20);
    }
  };
  const bambu = new BambuImplementation(async () => true);
  bambu.getPrinter = async () => printer;
  return { bambu, printer };
}

test("replies are matched by sequence_id; status pushes and request echoes never count", () => {
  assert.deepEqual(matchCommandReply({ print: { command: "pause", sequence_id: "40001", result: "success", reason: "success" } }, "40001"),
    { section: "print", command: "pause", result: "success", reason: "success" });
  assert.equal(matchCommandReply({ print: { command: "pause", sequence_id: "40002", result: "success" } }, "40001"), undefined);
  assert.equal(matchCommandReply({ print: { command: "push_status", sequence_id: "40001", gcode_state: "IDLE" } }, "40001"), undefined);
  assert.equal(matchCommandReply({ print: { command: "pause", sequence_id: "40001", param: "" } }, "40001"), undefined);
  assert.deepEqual(matchCommandReply(JSON.stringify({ system: { command: "ledctrl", sequence_id: 40003, result: "success" } }), "40003"),
    { section: "system", command: "ledctrl", result: "success" });
  assert.match(commandReplyFailure({ command: "resume", result: "fail", reason: "printer is busy" }), /refused resume: printer is busy/);
  assert.match(commandReplyFailure({ command: "stop", result: "success", errCode: 0x0500_4002 }), /error 05004002/);
  assert.equal(commandReplyFailure({ command: "stop", result: "success", errCode: 0 }), undefined);
  assert.equal(commandSequenceId('{"print":{"command":"stop","sequence_id":"41000"}}'), "41000");
});

test("a LAN command reports the printer's own reply to its sequence id", async (t) => {
  withReplyWait(t, 2000);
  const { bambu, printer } = answeringPrinter(body => [
    { print: { command: "push_status", sequence_id: body.sequence_id, gcode_state: "PAUSE" } },
    { print: { command: body.command, sequence_id: "1", result: "fail" } },
    { print: { command: body.command, sequence_id: body.sequence_id, result: "success", reason: "success" } },
  ]);
  const result = await bambu.pauseJob(host, serial, token);
  assert.match(printer.published[0].print.sequence_id, /^4\d{4}$/, "bambu-node commands are numbered from the server's range");
  assert.deepEqual(result.printerReply, { result: "success", reason: "success" });
  assert.match(result.message, /Pause command sent successfully\. The printer replied: success\./);
});

test("a LAN command the printer refuses is an error with its reason", async (t) => {
  withReplyWait(t, 2000);
  const { bambu } = answeringPrinter(body => ({ print: { command: body.command, sequence_id: body.sequence_id, result: "fail", reason: "not supported", err_code: 0x0300_8001 } }));
  await assert.rejects(bambu.setPrintSpeed(host, serial, token, "sport"), /refused print_speed: not supported \(error 03008001\)/);
  await assert.rejects(bambu.setLight(host, serial, token, "chamber_light", "on"), /refused ledctrl/);
});

test("no reply within the wait is reported, not an error, and does not hang", async (t) => {
  withReplyWait(t, 150);
  const { bambu } = answeringPrinter(() => undefined);
  const started = Date.now();
  const result = await bambu.skipObjects(host, serial, token, [3]);
  assert.ok(Date.now() - started < 1500);
  assert.equal(result.printerReply, null);
  assert.match(result.message, /no reply within 0\.15 s/);
});

test("a signed bridge command waits for the printer's reply among the plugin's message events", async (t) => {
  withReplyWait(t, 2000);
  const bridge = new BambuNetworkBridge();
  let sent;
  let polls = 0;
  bridge.ensurePrinterChannel = async () => {};
  bridge.callWithAgent = async (method, payload = {}) => {
    if (method === "net.send_message") sent = JSON.parse(payload.msg);
    return { ok: true, value: 0 };
  };
  bridge.request = async (method) => {
    assert.equal(method, "bridge.poll_events");
    polls++;
    if (!sent) return { ok: true, events: [{ name: "on_message", payload: { dev_id: "31BTEST", msg: JSON.stringify({ print: { command: "push_status" } }) } }] };
    const sequence_id = sent.print.sequence_id;
    return { ok: true, events: [
      { name: "on_message", payload: { dev_id: "OTHER", msg: JSON.stringify({ print: { command: "resume", sequence_id, result: "fail" } }) } },
      { name: "on_message", payload: { dev_id: "31BTEST", msg: JSON.stringify({ print: { command: "resume", sequence_id, result: "success", reason: "success" } }) } },
    ] };
  };
  const out = await bridge.sendPrinterCommand("31BTEST", JSON.stringify({ print: { command: "resume", param: "", sequence_id: "42000" } }));
  assert.equal(out.code, 0);
  assert.deepEqual(out.reply, { section: "print", command: "resume", result: "success", reason: "success" });
  assert.ok(polls >= 2, "the backlog is drained before sending");

  sent = undefined;
  bridge.request = async () => sent ? { ok: true, events: [{ name: "on_message", payload: { dev_id: "31BTEST", msg: JSON.stringify({ print: { command: "stop", sequence_id: sent.print.sequence_id, result: "fail", reason: "busy" } }) } }] } : { ok: true, events: [] };
  await assert.rejects(bridge.sendPrinterCommand("31BTEST", JSON.stringify({ print: { command: "stop", sequence_id: "42001" } })), /refused stop: busy/);

  bridge.request = async () => ({ ok: true, events: [] });
  const silent = await bridge.sendPrinterCommand("31BTEST", JSON.stringify({ print: { command: "pause", sequence_id: "42002" } }), { replyMs: 100 });
  assert.equal(silent.reply, undefined);
  assert.equal(silent.waitedMs, 100);
});
