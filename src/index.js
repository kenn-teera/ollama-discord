import { ActivityType, Client, GatewayIntentBits, Partials } from 'discord.js';
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

// Command replies (--help, --info, --reset) are sent in a code block so they stay monospaced and aligned.
const codeBlock = (text) => `\`\`\`\n${text}\n\`\`\``;

// Reply to --info: public-safe status (no prompt, channel IDs, tokens or commands).
function botInfo(msg) {
  const config = getConfig();
  const tools = currentTools().map((t) => t.function.name);
  const recent = activity.filter((a) => !a.error).slice(0, 10);
  const avgMs = recent.length ? recent.reduce((n, a) => n + a.ms, 0) / recent.length : 0;
  const up = Math.floor((Date.now() - stats.startedAt) / 60000);
  const kept = histories.get(historyKey(msg))?.length ?? 0;
  const total = stats.inputTokens + stats.outputTokens;
  return [
    'Bot info',
    `Model: ${config.model}${config.thinking ? ' (thinking on)' : ''}`,
    `Status: ${config.paused ? 'paused by admin' : 'online'}`,
    `Tools: ${tools.length ? `${tools.length} (${tools.slice(0, 5).join(', ')}${tools.length > 5 ? ', ...' : ''})` : 'off'}`,
    `Your conversation: ${kept} message${kept === 1 ? '' : 's'} kept (up to ${config.historyLimit}, ${config.historyScope === 'user' ? 'private to you' : 'shared in this channel'})`,
    `Up ${Math.floor(up / 60)}h ${up % 60}m | ${stats.replies} ${stats.replies === 1 ? 'reply' : 'replies'}, ${stats.errors} ${stats.errors === 1 ? 'error' : 'errors'}${recent.length ? ` | avg reply ${(avgMs / 1000).toFixed(1)}s` : ''} | ${total.toLocaleString()} tokens used`,
    config.userCooldown ? `Cooldown: ${config.userCooldown}s between questions` : null,
    'Type --help to see all commands.',
  ].filter(Boolean).join('\n');
}

// Chat commands, sent as "--name" after the @mention (or in a DM). --help is generated from this list.
const COMMANDS = {
  help: { about: 'list all commands', run: () => commandHelp() },
  info: { about: 'show model, tools, your conversation size and usage', run: (msg) => botInfo(msg) },
  reset: {
    about: 'clear your conversation history',
    run: (msg) => {
      histories.delete(historyKey(msg));
      return 'Conversation reset.';
    },
  },
};
const commandHelp = () => ['Commands', ...Object.entries(COMMANDS).map(([name, c]) => `--${name.padEnd(5)} ${c.about}`)].join('\n');

// 'user': each person has their own conversation in a channel; 'channel': everyone in the channel shares one.
const historyKey = (msg) => (getConfig().historyScope === 'user' ? `${msg.channelId}:${msg.author.id}` : msg.channelId);

// Custom Discord status text; only sent when it changed (Discord rate-limits presence updates).
let shownStatus = null;
function applyStatus() {
  const text = getConfig().botStatus;
  if (!client.isReady() || text === shownStatus) return;
  shownStatus = text;
  client.user.setPresence({ activities: text ? [{ name: 'custom', type: ActivityType.Custom, state: text }] : [] });
}
onConfigChange(applyStatus);

const lastAsked = new Map(); // userId -> time of last accepted question, for the cooldown

client.once('clientReady', (c) => {
  applyStatus();
  console.log(`Logged in as ${c.user.tag}, using model ${getConfig().model}, tools: ${currentTools().map((t) => t.function.name).join(', ') || 'none'}`);
});

client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  const isDM = !msg.guild;
  const mentioned = msg.mentions.has(client.user);
  if (!isDM && !mentioned) return;
  const { allowedChannels } = getConfig();
  if (!isDM && allowedChannels.length && !allowedChannels.includes(msg.channelId)) return; // silently ignore other channels

  const prompt = msg.content.replace(/<@!?\d+>/g, '').trim();
  if (!prompt) return;

  if (prompt.startsWith('--')) {
    const name = prompt.slice(2).split(/\s/)[0].toLowerCase();
    const reply = Object.hasOwn(COMMANDS, name) ? COMMANDS[name].run(msg) : `Unknown command: --${name.slice(0, 30)}\nType --help to see all commands.`;
    await msg.reply(codeBlock(reply)).catch(() => {});
    return;
  }

  const config = getConfig();
  if (config.paused) {
    await msg.reply('The bot is paused by its admin.').catch(() => {});
    return;
  }

  const wait = Math.ceil(((lastAsked.get(msg.author.id) ?? 0) + config.userCooldown * 1000 - Date.now()) / 1000);
  if (wait > 0) {
    await msg.reply(`Please wait ${wait}s before asking again.`).catch(() => {});
    return;
  }
  lastAsked.set(msg.author.id, Date.now());

  const key = historyKey(msg); // fixed now so a settings change mid-reply can't split the conversation
  const history = histories.get(key) ?? [];
  history.push({ role: 'user', content: prompt });

  const started = Date.now();
  const entry = { time: started, user: msg.author.username, prompt: prompt.slice(0, 80), usedTools: false, ms: 0, inputTokens: 0, outputTokens: 0, timing: null };
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
    entry.timing = { loadMs: Math.round(usage.loadMs), promptMs: Math.round(usage.promptMs), evalMs: Math.round(usage.evalMs), toolMs: usage.toolMs, calls: usage.calls };
    stats.inputTokens += usage.input;
    stats.outputTokens += usage.output;
    history.push({ role: 'assistant', content: reply });
    if (entry.usedTools && config.showSearchTag) reply = `(search) ${reply}`;
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
