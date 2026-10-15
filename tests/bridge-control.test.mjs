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
  return { bridge, calls };
}

test("cloud control signs in, waits for the server, subscribes once and sends msg", async () => {
  const { bridge, calls } = fakeBridge({ connectedAfter: 1 });
  const message = JSON.stringify({ print: { command: "clean_print_error", sequence_id: "0" } });
  assert.equal(await bridge.sendPrinterMessage("31BTEST", message), 0);
  assert.deepEqual(calls.map(call => call.method), ["net.is_user_login", "net.is_server_connected", "net.is_server_connected",
    "net.start_subscribe", "net.add_subscribe", "net.send_message"]);
  assert.deepEqual(calls[3].payload, { module: "app" });
  assert.deepEqual(calls[4].payload, { devs: ["31BTEST"] });
  assert.deepEqual(calls[5].payload, { dev_id: "31BTEST", msg: message, qos: 1, flag: 0 });
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
});
