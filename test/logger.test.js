import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOGGER = fileURLToPath(new URL('../src/logger.js', import.meta.url));

// Runs a small program that uses the real logger, with its own log directory
function run(code, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ollama-discord-logs-'));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { captureConsole, logClientErrors } from ${JSON.stringify(LOGGER)}; captureConsole(); ${code}`], {
    env: { ...process.env, LOG_DIR: dir, ...env }, encoding: 'utf8', timeout: 15000,
  });
  const logged = (() => { try { return readFileSync(join(dir, 'bot.jsonl'), 'utf8'); } catch { return ''; } })();
  return { ...result, logged };
}

test('a stray promise rejection is logged and the bot keeps running', () => {
  const r = run("Promise.reject(new Error('stray failure')); setTimeout(() => console.log('still alive'), 200);");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /still alive/);
  assert.match(r.logged, /Unhandled rejection/);
  assert.match(r.logged, /stray failure/);
});

test('an uncaught exception is logged and then the process exits with an error', () => {
  const r = run("setTimeout(() => { throw new Error('fatal bug'); }, 10); setTimeout(() => console.log('must not print'), 600);");
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /must not print/);
  assert.match(r.logged, /Uncaught exception/);
  assert.match(r.logged, /fatal bug/);
});

test('the Discord token is scrubbed from the log but not hidden from the console', () => {
  const r = run("console.log('login with ' + process.env.DISCORD_TOKEN);", { DISCORD_TOKEN: 'super-secret-token-value' });
  assert.equal(r.logged.includes('super-secret-token-value'), false);
  assert.match(r.logged, /\[token\]/);
});

test('without listeners a client error is fatal; logClientErrors makes it a log line', () => {
  const bare = spawnSync(process.execPath, ['-e', "new (require('node:events'))().emit('error', new Error('gateway hiccup'))"], { encoding: 'utf8' });
  assert.notEqual(bare.status, 0, 'an unhandled error event throws');
  const r = run("const c = new (await import('node:events')).EventEmitter(); logClientErrors(c); c.emit('error', new Error('gateway hiccup')); c.emit('shardError', new Error('shard down')); c.emit('warn', 'slow heartbeat'); setTimeout(() => console.log('still alive'), 100);");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /still alive/);
  assert.match(r.logged, /Discord client error/);
  assert.match(r.logged, /gateway hiccup/);
  assert.match(r.logged, /Discord connection error/);
  assert.match(r.logged, /slow heartbeat/);
});
