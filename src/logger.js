import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';

// Two JSON-lines logs under logs/ (git-ignored): bot (everything the bot prints, incl. errors) and chat (questions and answers).
// Each file rotates at MAX_BYTES and keeps two older copies (.1, .2), so disk use stays bounded.
// LOG_DIR lets tests write somewhere else than the real logs/.
const DIR = process.env.LOG_DIR ? `${process.env.LOG_DIR}/` : fileURLToPath(new URL('../logs/', import.meta.url));
const MAX_BYTES = 2 * 1024 * 1024;
const FILES = { bot: 'bot.jsonl', chat: 'chat.jsonl' };
export const LOG_TYPES = Object.keys(FILES);

mkdirSync(DIR, { recursive: true });

const secret = process.env.DISCORD_TOKEN;
const scrub = (text) => (secret ? text.split(secret).join('[token]') : text);
const pathOf = (type) => `${DIR}${FILES[type]}`;

function rotate(path) {
  try {
    if (statSync(path).size < MAX_BYTES) return;
    try {
      renameSync(`${path}.1`, `${path}.2`);
    } catch {
      // no older copy yet
    }
    renameSync(path, `${path}.1`);
  } catch {
    // file does not exist yet
  }
}

function write(type, entry) {
  try {
    const path = pathOf(type);
    rotate(path);
    appendFileSync(path, scrub(JSON.stringify(entry)) + '\n');
  } catch {
    // logging must never break the bot
  }
}

export const logChat = (entry) => write('chat', entry);

// Copies everything printed with console.log/info/warn/error into the bot log (it still prints as before), and records crashes.
// An uncaught exception leaves the program in an unknown state, so it is logged and the process exits (Node's default). A stray
// promise rejection (say a failed presence update) is logged and the bot keeps running; one failed side task should not take the
// bot offline until someone restarts it.
export function captureConsole() {
  for (const [method, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      write('bot', { time: Date.now(), level, msg: format(...args).slice(0, 4000) });
    };
  }
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
  });
}

// Without error listeners, a gateway or network hiccup is an uncaught 'error' event on the discord.js client and takes the whole bot down.
export function logClientErrors(client) {
  client.on('error', (err) => console.error('Discord client error:', err));
  client.on('shardError', (err) => console.error('Discord connection error:', err));
  client.on('warn', (message) => console.warn('Discord warning:', message));
}

const isIssue = (e) => e.level === 'warn' || e.level === 'error' || Boolean(e.error);
const isError = (e) => e.level === 'error' || Boolean(e.error);

// Newest first. level: all | issues (warnings and errors) | error. q: case-insensitive text match.
export function readLog(type, { limit = 200, level = 'all', q = '' } = {}) {
  const base = pathOf(type);
  const needle = q.toLowerCase();
  const out = [];
  for (const path of [base, `${base}.1`, `${base}.2`]) {
    let lines;
    try {
      lines = readFileSync(path, 'utf8').split('\n');
    } catch {
      continue;
    }
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      if (!lines[i]) continue;
      let e;
      try {
        e = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (level === 'issues' && !isIssue(e)) continue;
      if (level === 'error' && !isError(e)) continue;
      if (needle && !lines[i].toLowerCase().includes(needle)) continue;
      out.push(e);
    }
    if (out.length >= limit) break;
  }
  return out;
}

export const errorsSince = (ms) => readLog('bot', { limit: 1000, level: 'error' }).filter((e) => e.time > Date.now() - ms).length;

export function clearLog(type) {
  for (const path of [pathOf(type), `${pathOf(type)}.1`, `${pathOf(type)}.2`]) {
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  }
}
