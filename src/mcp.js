import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// MCP_SERVERS_FILE lets tests use a throwaway catalog instead of the real mcp-servers.json.
const CATALOG_FILE = process.env.MCP_SERVERS_FILE ?? fileURLToPath(new URL('../mcp-servers.json', import.meta.url));
const MAX_RESULT = 4000;
const ID_RE = /^[a-z0-9_-]{1,40}$/;

// MCP servers the dashboard can switch on. The browser only ever sends ids from this list; commands come from here, .env or mcp-servers.json.
const BUILTIN = [
  {
    id: 'searxng',
    label: 'SearXNG search',
    description: 'Local meta-search (free, no key). Run ./searxng/setup.sh first and set SEARXNG_URL in .env.',
    command: 'npx',
    args: ['-y', 'mcp-searxng'],
    envKeys: ['SEARXNG_URL'],
  },
];

// Legacy single-server setup from .env (MCP_COMMAND / MCP_ARGS / MCP_ENV_KEYS).
function envEntry() {
  if (!process.env.MCP_COMMAND) return [];
  return [{
    id: 'env',
    label: '.env server',
    description: `Configured by MCP_COMMAND in .env (${process.env.MCP_COMMAND}).`,
    command: process.env.MCP_COMMAND,
    args: (process.env.MCP_ARGS ?? '').split(' ').filter(Boolean),
    envKeys: (process.env.MCP_ENV_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean),
  }];
}

// Optional mcp-servers.json: { "servers": [{ "id", "label", "description", "command", "args": [], "envKeys": [] }] }
// Re-read only when the file changes, so edits show up without a restart.
let fileCache = { mtime: null, entries: [] };
function fileEntries() {
  let mtime;
  try {
    mtime = statSync(CATALOG_FILE).mtimeMs;
  } catch {
    return [];
  }
  if (mtime === fileCache.mtime) return fileCache.entries;
  const entries = [];
  try {
    const raw = JSON.parse(readFileSync(CATALOG_FILE, 'utf8')).servers;
    for (const s of Array.isArray(raw) ? raw : []) {
      const ok = s && ID_RE.test(s.id) && typeof s.command === 'string' && s.command
        && (s.args ?? []).every((a) => typeof a === 'string') && (s.envKeys ?? []).every((k) => typeof k === 'string');
      if (!ok) {
        console.error(`mcp-servers.json: skipped invalid entry ${JSON.stringify(s?.id)}`);
        continue;
      }
      entries.push({ label: s.id, description: '', args: [], envKeys: [], ...s });
    }
  } catch (err) {
    console.error('mcp-servers.json ignored:', err.message);
  }
  fileCache = { mtime, entries };
  return entries;
}

// Later sources win on the same id: file > .env > built-in.
export function catalog() {
  const byId = new Map();
  for (const s of [...BUILTIN, ...envEntry(), ...fileEntries()]) byId.set(s.id, s);
  return [...byId.values()];
}

export const catalogIds = () => catalog().map((s) => s.id);
export const defaultServers = () => (process.env.MCP_COMMAND ? ['env'] : ['searxng']);

// id -> { client, tools: [{ name (exposed), original, definition }], status, error }
const servers = new Map();
// exposed tool name -> { client, original }
const routes = new Map();

function rebuildRoutes() {
  routes.clear();
  const seen = new Set();
  for (const [id, s] of servers) {
    for (const t of s.tools) {
      // Two servers exposing the same tool name: prefix with the server id so both stay callable.
      t.name = seen.has(t.original) ? `${id}__${t.original}` : t.original;
      seen.add(t.original);
      routes.set(t.name, { client: s.client, original: t.original });
    }
  }
}

async function connect(entry) {
  const missing = entry.envKeys.filter((k) => !process.env[k]);
  if (missing.length) {
    servers.set(entry.id, { client: null, tools: [], status: 'error', error: `missing in .env: ${missing.join(', ')}` });
    return;
  }
  // The SDK passes no env by default, so secrets such as DISCORD_TOKEN stay private; forward only the declared keys.
  const env = Object.fromEntries(entry.envKeys.map((k) => [k, process.env[k]]));
  let client;
  try {
    client = new Client({ name: 'ollama-discord', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env, stderr: 'ignore' }));
    const { tools } = await client.listTools();
    servers.set(entry.id, {
      client,
      status: 'connected',
      error: null,
      tools: tools.map((t) => ({
        name: t.name,
        original: t.name,
        definition: { type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } },
      })),
    });
  } catch (err) {
    console.error(`MCP server "${entry.id}" unavailable:`, err.message);
    await client?.close().catch(() => {});
    servers.set(entry.id, { client: null, tools: [], status: 'error', error: err.message.slice(0, 200) });
  }
}

async function drop(id) {
  await servers.get(id)?.client?.close().catch(() => {});
  servers.delete(id);
}

let chain = Promise.resolve();

// Makes the connected set equal to `ids` (connects new ones, closes removed ones). Calls are serialized.
// With force, selected servers that failed are retried.
export function syncMcp(ids, { force = false } = {}) {
  chain = chain.then(async () => {
    const entries = new Map(catalog().map((s) => [s.id, s]));
    const wanted = ids.filter((id) => entries.has(id));
    for (const id of [...servers.keys()]) {
      if (!wanted.includes(id) || (force && servers.get(id).status === 'error')) await drop(id);
    }
    await Promise.all(wanted.filter((id) => !servers.has(id)).map((id) => connect(entries.get(id))));
    rebuildRoutes();
  }).catch((err) => console.error('MCP sync failed:', err.message));
  return chain;
}

// Ollama-format definitions of every tool on connected servers.
export const mcpTools = () => [...servers.values()].flatMap((s) => s.tools.map((t) => ({ ...t.definition, function: { ...t.definition.function, name: t.name } })));

// Per-server status for the dashboard. `active` is false while tools are disabled, so nothing is connected.
export function mcpStatus(selected, active) {
  return catalog().map((s) => {
    const live = servers.get(s.id);
    const missingEnv = s.envKeys.filter((k) => !process.env[k]);
    return {
      id: s.id,
      label: s.label,
      description: s.description,
      selected: selected.includes(s.id),
      status: !active || !selected.includes(s.id) ? 'off' : live?.status ?? 'connecting',
      error: live?.error ?? (missingEnv.length ? `missing in .env: ${missingEnv.join(', ')}` : null),
      tools: live?.tools.map((t) => t.name) ?? [],
    };
  });
}

export async function callTool(name, args) {
  const route = routes.get(name);
  if (!route) throw new Error(`unknown tool: ${name}`);
  const res = await route.client.callTool({ name: route.original, arguments: args });
  const text = (res.content ?? []).map((c) => c.text ?? '').join('\n');
  if (res.isError) throw new Error(text.slice(0, 300) || `${name} failed`); // MCP's own error flag
  return text.slice(0, MAX_RESULT);
}

export async function closeMcp() {
  await chain;
  await Promise.all([...servers.keys()].map(drop));
}
