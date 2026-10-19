import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A fake Ollama on a free port. Delay and status are set per test.
let delayMs = 0;
let status = 200;
const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['completion', 'tools', 'thinking'] }));
    seen.push(JSON.parse(body));
    setTimeout(() => {
      res.statusCode = status;
      res.end(status === 200
        ? JSON.stringify({ message: { role: 'assistant', content: 'hello' }, prompt_eval_count: 12, eval_count: 3, load_duration: 5e6, prompt_eval_duration: 2e9, eval_duration: 1e9 })
        : 'model exploded');
    }, delayMs);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.OLLAMA_HOST = `http://127.0.0.1:${server.address().port}`;
process.env.OLLAMA_TIMEOUT_SECONDS = '1';
process.env.CONFIG_FILE = join(mkdtempSync(join(tmpdir(), 'ollama-discord-ollama-')), 'config.json');
const { chat, newUsage } = await import('../src/ollama.js');
const { CONFIG_PATH } = await import('../src/config.js');
assert.equal(CONFIG_PATH, process.env.CONFIG_FILE, 'config.js is not using the isolated CONFIG_FILE');
after(() => server.close());

test('a normal reply is parsed and its timing and token counts recorded', async () => {
  delayMs = 0; status = 200;
  const usage = newUsage();
  const r = await chat([{ role: 'user', content: 'hi' }], { usage });
  assert.equal(r.content, 'hello');
  assert.deepEqual([usage.input, usage.output, usage.calls, usage.promptMs, usage.evalMs], [12, 3, 1, 2000, 1000]);
  assert.equal(seen.at(-1).think, false); // thinking models get think:false unless enabled
  assert.equal(seen.at(-1).stream, false);
});

test('a reply slower than the limit fails with a clear timeout error, not "is Ollama running"', async () => {
  delayMs = 2500; status = 200;
  await assert.rejects(chat([{ role: 'user', content: 'hi' }]), (err) => err.code === 'OLLAMA_TIMEOUT' && /did not answer within 1s/.test(err.message));
});

test('a reply that arrives within the limit works even when it is slow', async () => {
  delayMs = 700; status = 200;
  assert.equal((await chat([{ role: 'user', content: 'hi' }])).content, 'hello');
});

test('an error status is reported with Ollama\'s message', async () => {
  delayMs = 0; status = 500;
  await assert.rejects(chat([{ role: 'user', content: 'hi' }]), /Ollama 500: model exploded/);
});
