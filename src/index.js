import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { chat } from './ollama.js';
import { connectMcp, callTool, closeMcp } from './mcp.js';
import { fetchTool, fetchUrl } from './fetch.js';
import { getConfig, onConfigChange } from './config.js';
import { startWeb } from './web.js';

const MAX_LEN = 2000; // Discord message limit
const MAX_ACTIVITY = 50;

// Small models misuse the many options of the search tool (and its AI-answer mode is unreliable): expose only query/numResults.
const simplify = (t) =>
  t.function.name === 'web-search'
    ? { ...t, function: { ...t.function, parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The search query' }, numResults: { type: 'integer', description: 'Number of results (1-5)' } },
        required: ['query'],
      } } }
    : t;

let mcpTools = [];
// Connects to the MCP search server the first time search is enabled.
async function syncTools() {
  if (getConfig().searchEnabled && !mcpTools.length) mcpTools = await connectMcp();
}
const currentTools = () => (getConfig().searchEnabled ? [...mcpTools.map(simplify), fetchTool] : []);
await syncTools();
onConfigChange(() => syncTools());

// After a search, also read the top result so the model has real page text, not just snippets.
async function search(name, args) {
  const results = await callTool(name, { query: args.query, numResults: args.numResults, mode: 'web' });
  if (/^Error|Search failed/i.test(results)) {
    return 'SEARCH FAILED: the search service is temporarily unavailable. Do not answer from memory. Tell the user you could not search right now and to try again in a minute.';
  }
  const url = results.match(/URL:\s*(https?:\/\/\S+)/)?.[1];
  if (!url) return results;
  try {
    const page = await fetchUrl({ url });
    return `${results}\n\nContent of top result (${url}):\n${page}`;
  } catch {
    return results;
  }
}
const runTool = (name, args) => (name === fetchTool.function.name ? fetchUrl(args) : search(name, args));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// channelId -> [{ role, content }]
const histories = new Map();
const stats = { startedAt: Date.now(), replies: 0, errors: 0 };
const activity = []; // newest first

function record(entry) {
  activity.unshift(entry);
  activity.length = Math.min(activity.length, MAX_ACTIVITY);
}

function split(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += MAX_LEN) chunks.push(text.slice(i, i + MAX_LEN));
  return chunks;
}

client.once('clientReady', (c) => {
  console.log(`Logged in as ${c.user.tag}, using model ${getConfig().model}, tools: ${currentTools().map((t) => t.function.name).join(', ') || 'none'}`);
});

client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  const isDM = !msg.guild;
  const mentioned = msg.mentions.has(client.user);
  if (!isDM && !mentioned) return;

  const prompt = msg.content.replace(/<@!?\d+>/g, '').trim();
  if (!prompt) return;

  if (prompt === '!reset') {
    histories.delete(msg.channelId);
    await msg.reply('Conversation reset.');
    return;
  }

  const config = getConfig();
  if (config.paused) {
    await msg.reply('The bot is paused by its admin.').catch(() => {});
    return;
  }

  const history = histories.get(msg.channelId) ?? [];
  history.push({ role: 'user', content: prompt });

  const started = Date.now();
  const entry = { time: started, user: msg.author.username, prompt: prompt.slice(0, 80), usedTools: false, ms: 0 };
  try {
    await msg.channel.sendTyping();
    const typing = setInterval(() => msg.channel.sendTyping().catch(() => {}), 8000);
    let reply;
    try {
      ({ content: reply, usedTools: entry.usedTools } = await chat(
        [{ role: 'system', content: config.systemPrompt }, ...history],
        { tools: currentTools(), runTool },
      ));
    } finally {
      clearInterval(typing);
    }
    history.push({ role: 'assistant', content: reply });
    if (entry.usedTools) reply = `(search) ${reply}`;
    histories.set(msg.channelId, history.slice(-getConfig().historyLimit));

    const [first, ...rest] = split(reply || '(empty response)');
    await msg.reply(first);
    for (const part of rest) await msg.channel.send(part);
    stats.replies++;
  } catch (err) {
    history.pop();
    console.error(err);
    stats.errors++;
    entry.error = err.message.slice(0, 120);
    await msg.reply('Sorry, I could not reach the model. Is Ollama running?').catch(() => {});
  }
  entry.ms = Date.now() - started;
  record(entry);
});

startWeb({
  getStatus: () => ({
    botTag: client.user?.tag ?? null,
    ready: client.isReady(),
    tools: currentTools().map((t) => t.function.name),
    uptimeSeconds: Math.floor((Date.now() - stats.startedAt) / 1000),
    replies: stats.replies,
    errors: stats.errors,
    activity,
  }),
  clearHistory: () => histories.clear(),
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await closeMcp();
    process.exit(0);
  });
}

client.login(process.env.DISCORD_TOKEN);
