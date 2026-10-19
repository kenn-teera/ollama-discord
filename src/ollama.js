import { getConfig } from './config.js';

export const HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';

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
  const res = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (usage) {
    usage.input += data.prompt_eval_count ?? 0;
    usage.output += data.eval_count ?? 0;
  }
  return data.message;
}

// Runs the model; if it requests tools, executes them via runTool and feeds results back.
// Returns { content, usedTools, usage: { input, output } } (tokens summed over every model call for this reply).
export async function chat(messages, { tools, runTool } = {}) {
  const convo = [...messages];
  let usedTools = false;
  const usage = { input: 0, output: 0 };
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
      try {
        result = await runTool(name, args);
      } catch (err) {
        result = `Error: ${err.message}`;
      }
      convo.push({ role: 'tool', tool_name: name, content: result });
    }
    convo.push({ role: 'system', content: ANSWER_INSTRUCTION });
  }
  // Out of rounds: force a final answer without tools.
  return { content: (await request(convo, undefined, usage)).content, usedTools, usage };
}
