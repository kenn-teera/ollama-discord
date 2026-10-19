import http from 'node:http';
import https from 'node:https';
import { getConfig } from './config.js';

export const HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_SECONDS ?? 600) * 1000;

// POST JSON to Ollama and wait for the whole reply. Node's built-in fetch gives up after about 5 minutes without response
// headers, and a non-streamed reply from a big model on a small machine (a long prompt at ~75 tokens/s) can take longer while
// Ollama is working fine. node:http has no such limit, so the only limit is OLLAMA_TIMEOUT_SECONDS (default 10 minutes).
function postJson(path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, HOST);
    const payload = JSON.stringify(body);
    const req = (url.protocol === 'https:' ? https : http).request(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, signal: AbortSignal.timeout(TIMEOUT_MS) },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', (err) => {
      const timedOut = err.name === 'AbortError' || err.name === 'TimeoutError' || err.cause?.name === 'TimeoutError';
      reject(timedOut ? Object.assign(new Error(`Ollama did not answer within ${TIMEOUT_MS / 1000}s`), { code: 'OLLAMA_TIMEOUT' }) : err);
    });
    req.end(payload);
  });
}

// Added after tool results, whatever the system prompt says: small models tend to paste the raw text.
const ANSWER_INSTRUCTION = [
  'Now answer the user\'s question using the tool results above.',
  'Write it in your own words as a short summary (1-3 sentences) that states the key fact first.',
  'Do NOT copy or quote the tool text, do not list several results, and do not describe the search process.',
  'End with the single most relevant source URL on its own line.',
  'If the results do not contain the answer, say so in one sentence. Never invent facts.',
].join(' ');

// num_ctx: Ollama's default window is too small for tool results.
// What a model can do (completion, tools, thinking, vision...), asked once per model. Ollama rejects tools for models
// without "tools" (e.g. gemma3) and `think` for models without "thinking", so only send them when supported.
const capabilityCache = new Map();
async function capabilities(model) {
  if (capabilityCache.has(model)) return capabilityCache.get(model);
  try {
    const res = await fetch(`${HOST}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(5000),
    });
    const caps = (await res.json()).capabilities;
    if (Array.isArray(caps)) {
      capabilityCache.set(model, caps);
      return caps;
    }
  } catch {
    // Ollama unreachable or older version without capabilities: not cached, assume tools work and thinking does not
  }
  return ['tools'];
}
export const supportsTools = async (model) => (await capabilities(model)).includes('tools');
export const supportsThinking = async (model) => (await capabilities(model)).includes('thinking');

// `usage` (optional) accumulates Ollama's token counts: input = prompt tokens, output = generated tokens.
async function request(messages, tools, usage) {
  const { model, numCtx, temperature, thinking, topP, numPredict, keepAlive } = getConfig();
  const body = { model, messages, stream: false, options: { num_ctx: numCtx, temperature, top_p: topP, ...(numPredict > 0 && { num_predict: numPredict }) }, keep_alive: keepAlive };
  if (tools?.length && (await supportsTools(model))) body.tools = tools;
  // Thinking models reason before answering (slow, many extra tokens); default is off for a chat bot.
  if (await supportsThinking(model)) body.think = thinking;
  const res = await postJson('/api/chat', body);
  if (res.status < 200 || res.status >= 300) throw new Error(`Ollama ${res.status}: ${res.text}`);
  const data = JSON.parse(res.text);
  if (usage) {
    usage.input += data.prompt_eval_count ?? 0;
    usage.output += data.eval_count ?? 0;
    // Ollama reports nanoseconds: time to load the model, read the prompt and generate the answer.
    usage.loadMs += (data.load_duration ?? 0) / 1e6;
    usage.promptMs += (data.prompt_eval_duration ?? 0) / 1e6;
    usage.evalMs += (data.eval_duration ?? 0) / 1e6;
    usage.calls++;
  }
  return data.message;
}

// Runs the model; if it requests tools, executes them via runTool and feeds results back.
// Returns { content, usedTools, usage } where usage sums every model call for this reply: tokens (input/output),
// milliseconds (loadMs/promptMs/evalMs/toolMs), the number of model calls and the tools called (toolCalls).
export const newUsage = () => ({ input: 0, output: 0, loadMs: 0, promptMs: 0, evalMs: 0, toolMs: 0, calls: 0, toolCalls: [] });

// Short text for what a tool was called with (the query, URL, timezone...), shown in the dashboard and logs.
const describeArgs = (args) => Object.values(args ?? {}).filter((v) => typeof v === 'string' || typeof v === 'number').join(', ').slice(0, 100);

// The caller may pass its own `usage` (from newUsage) so what was recorded so far is kept even if the reply fails midway.
export async function chat(messages, { tools, runTool, usage = newUsage() } = {}) {
  const convo = [...messages];
  let usedTools = false;
  const maxRounds = getConfig().maxToolRounds;
  for (let round = 0; round < maxRounds; round++) {
    const msg = await request(convo, tools, usage);
    if (!msg.tool_calls?.length) return { content: msg.content, usedTools, usage };
    usedTools = true;
    convo.push(msg);
    for (const call of msg.tool_calls) {
      const { name, arguments: args } = call.function;
      console.log(`tool call: ${name}`, JSON.stringify(args));
      let result;
      let failed = false;
      const toolStart = Date.now();
      try {
        result = await runTool(name, args);
        failed = /^Error|^SEARCH FAILED/.test(result);
      } catch (err) {
        result = `Error: ${err.message}`;
        failed = true;
      }
      const took = Date.now() - toolStart;
      usage.toolMs += took;
      usage.toolCalls.push({ name, arg: describeArgs(args), ms: took, failed });
      convo.push({ role: 'tool', tool_name: name, content: result });
    }
    convo.push({ role: 'system', content: ANSWER_INSTRUCTION });
  }
  // Out of rounds: force a final answer without tools.
  return { content: (await request(convo, undefined, usage)).content, usedTools, usage };
}
