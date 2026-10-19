import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { chat } from './ollama.js';
import { syncMcp, mcpTools, mcpStatus, callTool, closeMcp } from './mcp.js';
import { fetchTool, fetchUrl } from './fetch.js';
import { getConfig, onConfigChange } from './config.js';
import { startWeb } from './web.js';

const MAX_LEN = 2000; // Discord message limit
const MAX_ACTIVITY = 50;

// Small models misuse the many options of the search tool (and its AI-answer mode is unreliable): expose only query/numResults.
const simplify = (t) => ({
  ...t,
  function: { ...t.function, parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'The search query' }, numResults: { type: 'integer', description: 'Number of results (1-5)' } },
    required: ['query'],
  } },
});
// Works with any MCP search server (web-search, searxng_web_search, ...); results are summarised with the top page read in full.
const isSearchTool = (t) => /web.?search/.test(t.function.name);

// Connects the MCP servers selected in the dashboard (only when tools are enabled).
const syncTools = (opts) => syncMcp(getConfig().searchEnabled ? getConfig().mcpServers : [], opts);
const searchTools = () => mcpTools().filter(isSearchTool);
// Search tools get the simplified schema; every other tool of a selected MCP server is passed to the model unchanged.
const otherTools = () => mcpTools().filter((t) => !isSearchTool(t));
const currentTools = () => (getConfig().searchEnabled ? [...searchTools().map(simplify), ...otherTools(), fetchTool] : []);
await syncTools();
onConfigChange(() => syncTools());

// After a search, also read the top result so the model has real page text, not just snippets.
// Maps our simple arguments onto whatever parameter names the MCP search tool declares.
function searchArgs(name, args) {
  const props = searchTools().find((t) => t.function.name === name)?.function.parameters.properties ?? {};
  const out = { query: args.query };
  if (args.numResults) {
    if ('numResults' in props) out.numResults = args.numResults;
    else if ('num_results' in props) out.num_results = args.numResults;
  }
  if ('mode' in props) out.mode = 'web';
  return out;
}

async function search(name, args) {
  const results = await callTool(name, searchArgs(name, args));
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
const runTool = (name, args) => {
  if (name === fetchTool.function.name) return fetchUrl(args);
  return searchTools().some((t) => t.function.name === name) ? search(name, args) : callTool(name, args);
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// history key -> [{ role, content }]; the key is channelId, or channelId:userId when historyScope is 'user'
const histories = new Map();
const stats = { startedAt: Date.now(), replies: 0, errors: 0, inputTokens: 0, outputTokens: 0 };
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

// 'user': each person has their own conversation in a channel; 'channel': everyone in the channel shares one.
const historyKey = (msg) => (getConfig().historyScope === 'user' ? `${msg.channelId}:${msg.author.id}` : msg.channelId);

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
    histories.delete(historyKey(msg));
    await msg.reply('Conversation reset.');
    return;
  }

  const config = getConfig();
  if (config.paused) {
    await msg.reply('The bot is paused by its admin.').catch(() => {});
    return;
  }

  const key = historyKey(msg); // fixed now so a settings change mid-reply can't split the conversation
  const history = histories.get(key) ?? [];
  history.push({ role: 'user', content: prompt });

  const started = Date.now();
  const entry = { time: started, user: msg.author.username, prompt: prompt.slice(0, 80), usedTools: false, ms: 0, inputTokens: 0, outputTokens: 0 };
  try {
    await msg.channel.sendTyping();
    const typing = setInterval(() => msg.channel.sendTyping().catch(() => {}), 8000);
    let reply, usage;
    try {
      ({ content: reply, usedTools: entry.usedTools, usage } = await chat(
        [{ role: 'system', content: config.systemPrompt }, ...history],
        { tools: currentTools(), runTool },
      ));
    } finally {
      clearInterval(typing);
    }
    entry.inputTokens = usage.input;
    entry.outputTokens = usage.output;
    stats.inputTokens += usage.input;
    stats.outputTokens += usage.output;
    history.push({ role: 'assistant', content: reply });
    if (entry.usedTools) reply = `(search) ${reply}`;
    histories.set(key, history.slice(-getConfig().historyLimit));

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
    mcpServers: mcpStatus(getConfig().mcpServers, getConfig().searchEnabled),
    uptimeSeconds: Math.floor((Date.now() - stats.startedAt) / 1000),
    replies: stats.replies,
    errors: stats.errors,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    activity,
  }),
  clearHistory: () => histories.clear(),
  reconnectMcp: () => syncTools({ force: true }),
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await closeMcp();
    process.exit(0);
  });
}

client.login(process.env.DISCORD_TOKEN);
