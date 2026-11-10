import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BambuNetworkBridge } from "../dist/bambu-network-bridge.js";

test("bridge status suggests FULU's native macOS host when it is installed", { skip: process.platform !== "darwin" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mac-host-"));
  const host = path.join(dir, "pjarczak_bambu_mac_host");
  const saved = process.env.PJARCZAK_MAC_NATIVE_HOST;
  try {
    process.env.PJARCZAK_MAC_NATIVE_HOST = host;
    assert.equal(new BambuNetworkBridge().getStatus({ bridgeCommand: "" }).runtime.macosNativeHostExists, false);
    fs.writeFileSync(host, "");
    const status = new BambuNetworkBridge().getStatus({ bridgeCommand: "" });
    assert.equal(status.runtime.macosNativeHostExists, true);
    assert.equal(status.runtime.suggestedMacCommand, `'${host}'`);
  } finally {
    if (saved === undefined) delete process.env.PJARCZAK_MAC_NATIVE_HOST; else process.env.PJARCZAK_MAC_NATIVE_HOST = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
