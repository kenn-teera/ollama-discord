import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { catalogIds, defaultServers } from './mcp.js';

// Runtime settings editable from the web dashboard. Precedence: config.json > .env > defaults.
const FILE = fileURLToPath(new URL('../config.json', import.meta.url));

export const DEFAULT_SYSTEM_PROMPT = [
  'You are a helpful assistant in a Discord server. Keep answers concise.',
  'For current events or facts you are unsure about, use the search tool. If the snippets do not contain the answer, use fetch_url on the most relevant result URL to read it.',
  'Answer ONLY from tool results, summarised in your own words (1-3 sentences, never copy the text), and cite the source URL. If the results do not contain the answer, say you could not find it and share the best link. Write URLs in full as plain text, never as markdown links like [this link]. Never guess or invent facts.',
].join(' ');

const envDefaults = {
  model: process.env.OLLAMA_MODEL ?? 'qwen2.5:7b',
  systemPrompt: process.env.SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT,
  historyLimit: Number(process.env.HISTORY_LIMIT ?? 10),
  historyScope: process.env.HISTORY_SCOPE ?? 'user',
  thinking: process.env.OLLAMA_THINKING === 'true',
  numCtx: Number(process.env.OLLAMA_NUM_CTX ?? 8192),
  temperature: Number(process.env.OLLAMA_TEMPERATURE ?? 0.8),
  maxToolRounds: Number(process.env.MAX_TOOL_ROUNDS ?? 4),
  searchEnabled: process.env.MCP_ENABLED !== 'false',
  mcpServers: defaultServers(),
  paused: false,
};

const int = (min, max) => (v) => {
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`must be a whole number from ${min} to ${max}`);
  return v;
};
const num = (min, max) => (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`must be a number from ${min} to ${max}`);
  return v;
};
const bool = (v) => {
  if (typeof v !== 'boolean') throw new Error('must be true or false');
  return v;
};
const validators = {
  model: (v) => {
    if (typeof v !== 'string' || !/^[A-Za-z0-9._\-:/]{1,100}$/.test(v)) throw new Error('invalid model name');
    return v;
  },
  systemPrompt: (v) => {
    if (typeof v !== 'string' || !v.trim() || v.length > 4000) throw new Error('must be 1-4000 characters');
    return v.trim();
  },
  historyLimit: int(1, 50),
  historyScope: (v) => {
    if (!['user', 'channel'].includes(v)) throw new Error('must be "user" or "channel"');
    return v;
  },
  numCtx: int(1024, 32768),
  temperature: num(0, 2),
  maxToolRounds: int(1, 8),
  thinking: bool,
  searchEnabled: bool,
  // Ids only: the commands behind them are fixed on the server (see mcp.js), never taken from the browser.
  mcpServers: (v) => {
    if (!Array.isArray(v) || v.length > 20) throw new Error('must be a list of server ids');
    const known = catalogIds();
    const bad = v.find((id) => !known.includes(id));
    if (bad !== undefined) throw new Error(`unknown MCP server: ${String(bad).slice(0, 40)}`);
    return [...new Set(v)];
  },
  paused: bool,
};

function load() {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

// Only values changed from the dashboard are saved, so later changes to .env/defaults still apply to the rest.
const saved = {};
for (const [k, v] of Object.entries(load())) {
  try {
    if (k in validators) saved[k] = validators[k](v);
  } catch {
    // ignore invalid saved value
  }
}
let config = { ...envDefaults, ...saved };

const listeners = [];
export const onConfigChange = (fn) => listeners.push(fn);
export const getConfig = () => config;

// Validates and applies a partial update, persists it, and notifies listeners. Throws on invalid input.
export function updateConfig(patch) {
  const next = { ...config };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in validators)) throw new Error(`unknown setting: ${k}`);
    try {
      next[k] = validators[k](v);
    } catch (err) {
      throw new Error(`${k}: ${err.message}`);
    }
  }
  config = next;
  for (const k of Object.keys(patch)) saved[k] = next[k];
  writeFileSync(`${FILE}.tmp`, JSON.stringify(saved, null, 2));
  renameSync(`${FILE}.tmp`, FILE);
  for (const fn of listeners) fn(config);
  return config;
}
