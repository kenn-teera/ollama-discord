import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated config file and a known .env default, set before config.js is loaded
const dir = mkdtempSync(join(tmpdir(), 'ollama-discord-config-'));
const file = join(dir, 'config.json');
process.env.CONFIG_FILE = file;
process.env.OLLAMA_MODEL = 'env-model:1b';
writeFileSync(file, JSON.stringify({ constructor: 1, toString: 'x', historyLimit: 7 }));
const { getConfig, updateConfig, CONFIG_PATH } = await import('../src/config.js');
// Safety: these tests write config files. Never run them against the real config.json.
assert.equal(CONFIG_PATH, file, 'config.js is not using the isolated CONFIG_FILE');
const onDisk = () => JSON.parse(readFileSync(file, 'utf8'));

test('inherited Object.prototype names are not settings', () => {
  for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    assert.throws(() => updateConfig(JSON.parse(`{"${key}": 1}`)), /unknown setting/, key);
  }
  assert.equal(typeof getConfig().toString, 'function'); // the config object's own methods are intact
});

test('junk keys in an existing config.json are ignored on load', () => {
  assert.equal(getConfig().historyLimit, 7); // the valid saved value is kept
  assert.equal(Object.hasOwn(getConfig(), 'constructor'), false);
});

test('saving a form with unchanged fields does not pin them', () => {
  // what the dashboard posts: every field, only the temperature differs
  const cfg = getConfig();
  updateConfig({ model: cfg.model, systemPrompt: cfg.systemPrompt, numCtx: cfg.numCtx, mcpServers: [...cfg.mcpServers], temperature: 0.3 });
  assert.deepEqual(Object.keys(onDisk()).sort(), ['historyLimit', 'temperature']);
  assert.equal(getConfig().temperature, 0.3);
  assert.equal(getConfig().model, 'env-model:1b'); // still follows .env
});

test('a setting that was already saved stays saved, even if re-sent unchanged', () => {
  updateConfig({ temperature: 0.3, historyLimit: 7 });
  assert.deepEqual(Object.keys(onDisk()).sort(), ['historyLimit', 'temperature']);
});

test('list settings compare by value', () => {
  updateConfig({ mcpServers: [...getConfig().mcpServers] });
  assert.equal(Object.hasOwn(onDisk(), 'mcpServers'), false);
  updateConfig({ allowedChannels: ['123456789012345678'] });
  assert.deepEqual(onDisk().allowedChannels, ['123456789012345678']);
});

test('invalid patches change nothing', () => {
  const before = JSON.stringify(onDisk());
  assert.throws(() => updateConfig({ topP: 5 }), /topP/);
  assert.equal(JSON.stringify(onDisk()), before);
  assert.equal(existsSync(`${file}.tmp`), false);
});
