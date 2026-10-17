import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const COMMAND = process.env.MCP_COMMAND ?? 'npx';
const ARGS = (process.env.MCP_ARGS ?? '-y @oevortex/ddg_search').split(' ').filter(Boolean);
// Env vars forwarded to the MCP server (the SDK passes none by default, so secrets such as DISCORD_TOKEN stay private).
const ENV = Object.fromEntries(
  (process.env.MCP_ENV_KEYS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k && process.env[k])
    .map((k) => [k, process.env[k]]),
);
const MAX_RESULT = 4000;

let client;

// Connects to the MCP server; returns Ollama-format tool definitions ([] if unavailable).
export async function connectMcp() {
  if (process.env.MCP_ENABLED === 'false') return [];
  try {
    client = new Client({ name: 'ollama-discord', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: COMMAND, args: ARGS, env: ENV, stderr: 'ignore' }));
    const { tools } = await client.listTools();
    return tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  } catch (err) {
    console.error('MCP unavailable, continuing without tools:', err.message);
    client = undefined;
    return [];
  }
}

export async function callTool(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.map((c) => c.text ?? '').join('\n');
  return text.slice(0, MAX_RESULT);
}

export async function closeMcp() {
  await client?.close().catch(() => {});
}
