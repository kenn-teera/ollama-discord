import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { chat, MODEL } from './ollama.js';

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ?? 'You are a helpful assistant in a Discord server. Keep answers concise.';
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
  console.log(`Logged in as ${c.user.tag}, using model ${MODEL}`);
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
    try {
      reply = await chat([{ role: 'system', content: SYSTEM_PROMPT }, ...history]);
    } finally {
      clearInterval(typing);
    }
    history.push({ role: 'assistant', content: reply });
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

client.login(process.env.DISCORD_TOKEN);
