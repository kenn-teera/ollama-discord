import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { getConfig, updateConfig, DEFAULT_SYSTEM_PROMPT } from './config.js';
import { HOST as OLLAMA_HOST, supportsTools } from './ollama.js';

const HOST = process.env.WEB_HOST ?? '127.0.0.1';
const PORT = Number(process.env.WEB_PORT ?? 8787);
const PASSWORD = process.env.WEB_PASSWORD;
const PAGE = readFileSync(new URL('./dashboard.html', import.meta.url));
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];

const safeEqual = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function installedModels() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return (await res.json()).models.map((m) => m.name);
  } catch {
    return null; // Ollama unreachable
  }
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new Error('request too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

// api: { getStatus(), clearHistory(), reconnectMcp() }
export function startWeb(api) {
  if (!LOOPBACK.includes(HOST) && !PASSWORD) {
    console.error(`Dashboard disabled: WEB_HOST=${HOST} is not loopback, so WEB_PASSWORD is required.`);
    return;
  }

  const server = createServer(async (req, res) => {
    try {
      // Block DNS-rebinding: on loopback only accept local host names.
      const hostname = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      if (LOOPBACK.includes(HOST) && !LOOPBACK.includes(hostname)) return send(res, 403, { error: 'forbidden host' });

      if (PASSWORD) {
        const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
        const given = scheme === 'Basic' ? Buffer.from(encoded ?? '', 'base64').toString().split(':').slice(1).join(':') : '';
        if (!safeEqual(given, PASSWORD)) {
          res.setHeader('WWW-Authenticate', 'Basic realm="ollama-discord"');
          return send(res, 401, 'Password required', 'text/plain');
        }
      }

      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, PAGE, 'text/html');

      if (req.method === 'GET' && url.pathname === '/api/state') {
        const models = await installedModels();
        return send(res, 200, {
          config: getConfig(),
          defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
          models: models ?? [],
          ollamaOnline: models !== null,
          modelSupportsTools: await supportsTools(getConfig().model),
          ...api.getStatus(),
        });
      }

      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        // CSRF: JSON content type forces a CORS preflight; also require same-origin when Origin is sent.
        if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'JSON required' });
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'cross-origin request blocked' });

        if (url.pathname === '/api/config') {
          const patch = await readJson(req);
          if (patch.model) {
            const models = await installedModels();
            if (models && !models.includes(patch.model)) {
              return send(res, 400, { error: `model "${patch.model}" is not installed (run: ollama pull ${patch.model})` });
            }
          }
          return send(res, 200, { config: updateConfig(patch) });
        }
        if (url.pathname === '/api/mcp-reconnect') {
          await api.reconnectMcp();
          return send(res, 200, { mcpServers: api.getStatus().mcpServers });
        }
        if (url.pathname === '/api/clear-history') {
          api.clearHistory();
          return send(res, 200, { ok: true });
        }
      }
      send(res, 404, { error: 'not found' });
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  });

  server.on('error', (err) => console.error(`Dashboard failed to start: ${err.message}`));
  server.listen(PORT, HOST, () => console.log(`Dashboard: http://${HOST === '::1' ? '[::1]' : HOST}:${PORT}`));
}
