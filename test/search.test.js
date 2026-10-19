import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSearchFailure, SEARCH_FAILED } from '../src/search.js';

test('only an error at the start of the reply counts as a failed search', () => {
  for (const text of ['Error: connection refused', 'error calling searxng', 'Search failed: timeout', '  Search failed']) assert.equal(isSearchFailure(text), true, text);
  for (const text of [
    'Title: Why does Elasticsearch say search failed?\nURL: https://example.org/q\nSnippet: the search failed because...',
    'Title: Error handling in Go\nURL: https://example.org/go',
    'Errors are values. Title: x', '', 'Title: Search failed exception (Java)',
  ]) assert.equal(isSearchFailure(text), false, text);
  assert.match(SEARCH_FAILED, /^SEARCH FAILED/); // ollama.js marks tool calls that start with this as failed
});

test('callTool throws when the MCP server flags an error, and returns text otherwise', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ollama-discord-mcp-'));
  const catalog = join(dir, 'mcp-servers.json');
  const fake = fileURLToPath(new URL('./fixtures/fake-mcp.mjs', import.meta.url));
  writeFileSync(catalog, JSON.stringify({ servers: [{ id: 'fake', label: 'Fake', command: process.execPath, args: [fake], envKeys: [] }] }));
  process.env.MCP_SERVERS_FILE = catalog;
  const { syncMcp, callTool, closeMcp, catalog: list } = await import('../src/mcp.js');
  assert.ok(list().some((s) => s.id === 'fake'), 'test catalog is not in use');
  await syncMcp(['fake']);
  try {
    assert.equal(await callTool('ok', {}), 'all good');
    await assert.rejects(callTool('boom', {}), /Error: backend down/);
    await assert.rejects(callTool('nope', {}), /unknown tool/);
  } finally {
    await closeMcp();
  }
});
