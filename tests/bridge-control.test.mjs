import assert from "node:assert/strict";
import { test } from "node:test";
import { BambuNetworkBridge } from "../dist/bambu-network-bridge.js";

// Bambu's plugin crashes in bambu_network_send_message without a cloud connection and a printer subscription,
// so the bridge client must sign in, connect, subscribe once, then send with the host's `msg` argument.
function fakeBridge(responses = {}) {
  const bridge = new BambuNetworkBridge();
  const calls = [];
  let connectedAfter = responses.connectedAfter ?? 0;
  bridge.callWithAgent = async (method, payload = {}) => {
    calls.push({ method, payload });
    if (method === "net.is_user_login") return { ok: true, value: responses.login ?? true };
    if (method === "net.is_server_connected") return { ok: true, value: connectedAfter-- <= 0 };
    if (method === "net.send_message") return { ok: true, value: responses.sendResult ?? 0 };
    return { ok: true, value: 0 };
  };
  bridge.request = async (method) => {
    calls.push({ method });
    if (method === "bridge.poll_events") return { ok: true, events: responses.events ?? [{ name: "on_printer_connected", payload: { topic_str: "31BTEST" } }, { name: "on_message", payload: { dev_id: "31BTEST", msg: "{}" } }] };
    return { ok: true };
  };
  return { bridge, calls };
}

test("cloud control signs in, waits for the server, subscribes once and sends msg", async () => {
  const { bridge, calls } = fakeBridge({ connectedAfter: 1 });
  const message = JSON.stringify({ print: { command: "clean_print_error", sequence_id: "0" } });
  assert.equal(await bridge.sendPrinterMessage("31BTEST", message), 0);
  assert.deepEqual(calls.map(call => call.method), ["net.is_user_login", "net.is_server_connected", "net.is_server_connected",
    "net.set_on_server_connected_fn", "net.set_on_printer_connected_fn", "net.set_on_subscribe_failure_fn", "net.set_on_message_fn",
    "net.set_user_selected_machine", "net.start_subscribe", "net.add_subscribe", "bridge.poll_events",
    "net.send_message", "net.send_message", "net.update_cert", "net.install_device_cert", "net.send_message"]);
  const payload = method => calls.filter(call => call.method === method).at(-1).payload;
  assert.deepEqual(payload("net.install_device_cert"), { dev_id: "31BTEST", lan_only: false });
  assert.deepEqual(payload("net.set_user_selected_machine"), { dev_id: "31BTEST" });
  assert.deepEqual(payload("net.start_subscribe"), { module: "app" });
  assert.deepEqual(payload("net.add_subscribe"), { devs: ["31BTEST"] });
  assert.deepEqual(payload("net.send_message"), { dev_id: "31BTEST", msg: message, qos: 1, flag: 0 });
  calls.length = 0;
  await bridge.sendPrinterMessage("31BTEST", message);
  assert.deepEqual(calls.map(call => call.method), ["net.is_user_login", "net.is_server_connected", "net.send_message"], "subscription is reused");
});

test("cloud control refuses without a signed-in account, and reports a plugin refusal", async () => {
  const signedOut = fakeBridge({ login: false });
  await assert.rejects(signedOut.bridge.sendPrinterMessage("31BTEST", "{}"), /not signed in/i);
  assert.ok(!signedOut.calls.some(call => call.method === "net.send_message"));
  const refused = fakeBridge({ sendResult: -2 });
  await assert.rejects(refused.bridge.sendPrinterMessage("31BTEST", "{}"), /refused the printer command \(send_message returned -2\)/);
  await assert.rejects(fakeBridge().bridge.sendPrinterMessage(" ", "{}"), /dev_id is required/);
  const unbound = fakeBridge({ events: [{ name: "on_subscribe_failure", payload: {} }] });
  await assert.rejects(unbound.bridge.sendPrinterMessage("31BTEST", "{}"), /refused the subscription/);
  assert.ok(!unbound.calls.some(call => call.method === "net.send_message"));
});

// Bambu Studio connects a LAN printer itself (MachineObject::connect) and waits for on_local_connect before a LAN print.
function fakeLocalBridge({ connectResult = 0, events } = {}) {
  const bridge = new BambuNetworkBridge();
  const calls = [];
  bridge.callWithAgent = async (method, payload = {}) => {
    calls.push({ method, payload });
    if (method === "net.connect_printer") return { ok: true, value: connectResult };
    return { ok: true, value: 0 };
  };
  bridge.request = async (method) => {
    calls.push({ method });
    if (method === "bridge.poll_events") return { ok: true, events: events ?? [
      { name: "on_local_connect", payload: { status: 0, dev_id: "31BTEST", msg: "" } },
      { name: "on_local_message", payload: { dev_id: "31BTEST", msg: JSON.stringify({ print: { command: "push_status", gcode_state: "IDLE" } }) } },
    ] };
    return { ok: true };
  };
  return { bridge, calls };
}

test("a LAN bridge print first opens the plugin's LAN session like Studio: connect, push, report, certificate", async () => {
  const { bridge, calls } = fakeLocalBridge();
  await bridge.ensureLocalChannel("31BTEST", "192.0.2.5", "CODE");
  assert.deepEqual(calls.map(call => call.method), ["net.set_on_local_connect_fn", "net.set_on_local_message_fn", "net.set_on_printer_connected_fn",
    "net.update_cert", "net.connect_printer", "bridge.poll_events", "net.send_message_to_printer", "net.send_message_to_printer",
    "bridge.poll_events", "net.install_device_cert"]);
  const payload = method => calls.filter(call => call.method === method).map(call => call.payload);
  assert.deepEqual(payload("net.connect_printer"), [{ dev_id: "31BTEST", dev_ip: "192.0.2.5", username: "bblp", password: "CODE", use_ssl: true }]);
  assert.deepEqual(payload("net.send_message_to_printer").map(p => Object.keys(JSON.parse(p.msg))[0]), ["pushing", "info"]);
  assert.deepEqual(payload("net.install_device_cert"), [{ dev_id: "31BTEST", lan_only: true }]);
  calls.length = 0;
  await bridge.ensureLocalChannel("31BTEST", "192.0.2.5", "CODE");
  assert.deepEqual(calls, [], "the LAN session is reused");
});

test("a LAN bridge session that fails to connect stops before anything is sent", async () => {
  const wrongCode = fakeLocalBridge({ events: [{ name: "on_local_connect", payload: { status: 1, dev_id: "31BTEST", msg: "5" } }] });
  await assert.rejects(wrongCode.bridge.ensureLocalChannel("31BTEST", "192.0.2.5", "BAD"), /refused the LAN access code.*nothing was sent/);
  const refused = fakeLocalBridge({ connectResult: -1 });
  await assert.rejects(refused.bridge.ensureLocalChannel("31BTEST", "192.0.2.5", "CODE"), /connect_printer returned -1/);
  for (const { calls } of [wrongCode, refused]) {
    assert.ok(!calls.some(call => call.method === "net.send_message_to_printer" || call.method === "net.install_device_cert"));
  }
  await assert.rejects(fakeLocalBridge().bridge.ensureLocalChannel("31BTEST", "", "CODE"), /address and LAN access code/);
});

// Bambu Studio restores the plugin's on_message / on_local_message pushes onto the last full report too.
test("the plugin's printer pushes are restored per printer, and command replies survive the poll that saw them", async () => {
  const bridge = new BambuNetworkBridge();
  const queue = [];
  bridge.request = async (method) => method === "bridge.poll_events" ? { ok: true, events: queue.splice(0) } : { ok: true };
  const msg = (dev_id, message, name = "on_message") => ({ name, payload: { dev_id, msg: JSON.stringify(message) } });
  queue.push(
    msg("31BTEST", { print: { command: "push_status", msg: 1, gcode_state: "RUNNING" } }),
    msg("31BTEST", { print: { command: "push_status", msg: 0, gcode_state: "IDLE", ams: { tray_exist_bits: "1", tray_now: "255" } } }),
    msg("31BTEST", { print: { command: "push_status", msg: 1, ams: { tray_now: "0" } } }, "on_local_message"),
    msg("31BOTHER", { print: { command: "push_status", msg: 0, gcode_state: "FINISH" } }),
    msg("31BTEST", { print: { command: "clean_print_error", sequence_id: "40123", result: "success" } }),
  );
  assert.equal(await bridge.awaitPrinterReply("31BTEST", "40999", 0), undefined);
  const state = bridge.printerReport("31BTEST").state();
  assert.equal(state.gcode_state, "IDLE");
  assert.deepEqual(state.ams, { tray_exist_bits: "1", tray_now: "0" });
  assert.equal(bridge.printerReport("31BOTHER").state().gcode_state, "FINISH");
  // The reply was polled while waiting for another command; it is still found for its own sequence id.
  assert.deepEqual(await bridge.awaitPrinterReply("31BTEST", "40123", 0), { section: "print", command: "clean_print_error", result: "success" });
});
