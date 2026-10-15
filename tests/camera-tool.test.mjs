import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const preload = fileURLToPath(new URL('./fixtures/camera-fake-frame.mjs', import.meta.url));

test('camera_snapshot returns the frame as an MCP image with a short text summary', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'camera-tool-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', preload, entry], cwd: dir, stderr: 'pipe',
    env: { HOME: dir, MCP_TRANSPORT: 'stdio', BAMBU_MODEL: '', BAMBU_PRINTER_HOST: '127.0.0.1', PRINTER_HOST: '127.0.0.1',
      BAMBU_SERIAL: 'S', BAMBU_TOKEN: 'T', INSPECTION_NETWORK_LOG: join(dir, 'network.log') } });
  transport.stderr.on('data', () => {});
  const client = new Client({ name: 'camera-tool-test', version: '1' }, { capabilities: {} });
  t.after(async () => { await client.close(); await transport.close(); await rm(dir, { recursive: true, force: true }); });
  await client.connect(transport);
  const savePath = join(dir, 'frame.jpg');
  const result = await client.callTool({ name: 'camera_snapshot', arguments: { bambu_model: 'h2c', save_path: savePath } });
  assert.equal(result.isError, undefined);
  const [text, image] = result.content;
  assert.deepEqual({ type: image.type, mimeType: image.mimeType, data: image.data }, { type: 'image', mimeType: 'image/jpeg', data: '/9gSNP/Z' });
  const info = JSON.parse(text.text);
  assert.equal(info.status, 'success');
  assert.equal(info.transport, 'rtsps-322');
  assert.equal(info.base64, undefined, 'the frame is not repeated as text');
  assert.deepEqual([...await readFile(savePath)], [0xff, 0xd8, 0x12, 0x34, 0xff, 0xd9]);
});
