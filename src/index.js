import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { chat, MODEL } from './ollama.js';
import { connectMcp, callTool, closeMcp } from './mcp.js';
import { fetchTool, fetchUrl } from './fetch.js';

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ??
  [
    'You are a helpful assistant in a Discord server. Keep answers concise.',
    'For current events or facts you are unsure about, use the web-search tool. If the snippets do not contain the answer, use fetch_url on the most relevant result URL to read it.',
    'Answer ONLY from tool results and cite the source URL. If the results do not contain the answer, say you could not find it and share the best link. Write URLs in full as plain text, never as markdown links like [this link]. Never guess or invent facts.',
  ].join(' ');
const mcpTools = await connectMcp();
// Small models misuse the many options of the search tool (and its AI-answer mode is unreliable): expose only query/numResults.
const simplify = (t) =>
  t.function.name === 'web-search'
    ? { ...t, function: { ...t.function, parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The search query' }, numResults: { type: 'integer', description: 'Number of results (1-5)' } },
        required: ['query'],
      } } }
    : t;
const tools = [...mcpTools.map(simplify), fetchTool];
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

const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT ?? 10);
const MAX_LEN = 2000; // Discord message limit

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

function split(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += MAX_LEN) chunks.push(text.slice(i, i + MAX_LEN));
  return chunks;
}

client.once('clientReady', (c) => {
  console.log(`Logged in as ${c.user.tag}, using model ${MODEL}, tools: ${tools.map((t) => t.function.name).join(', ') || 'none'}`);
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

  const history = histories.get(msg.channelId) ?? [];
  history.push({ role: 'user', content: prompt });

  try {
    await msg.channel.sendTyping();
    const typing = setInterval(() => msg.channel.sendTyping().catch(() => {}), 8000);
    let reply;
    let usedTools;
    try {
      ({ content: reply, usedTools } = await chat([{ role: 'system', content: SYSTEM_PROMPT }, ...history], { tools, runTool }));
    } finally {
      clearInterval(typing);
    }
    history.push({ role: 'assistant', content: reply });
    if (usedTools) reply = `(search) ${reply}`;
    histories.set(msg.channelId, history.slice(-HISTORY_LIMIT));

    const [first, ...rest] = split(reply || '(empty response)');
    await msg.reply(first);
    for (const part of rest) await msg.channel.send(part);
  } catch (err) {
    history.pop();
    console.error(err);
    await msg.reply('Sorry, I could not reach the model. Is Ollama running?').catch(() => {});
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await closeMcp();
    process.exit(0);
  });
}

client.login(process.env.DISCORD_TOKEN);
