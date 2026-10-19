import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, MessageMentions, MessagePayload, TextChannel } from 'discord.js';
import { ALLOWED_MENTIONS, isAddressedToBot, safeName } from '../src/mentions.js';

const BOT = { id: 'bot-1' };
const BOT_MANAGED_ROLE = { id: 'role-bot' };
const OTHER_ROLE = { id: 'role-team' };

// A message whose mentions use discord.js's real MessageMentions#has, over fake data
function message({ guild = true, everyone = false, users = [], roles = [], botRoles = [] } = {}) {
  const roleMap = new Map(roles.map((r) => [r.id, r]));
  const member = { roles: { cache: new Map(botRoles.map((r) => [r.id, r])), botRole: BOT_MANAGED_ROLE } };
  const fake = {
    client: { users: { resolve: (d) => (d?.id === BOT.id ? BOT : null) }, channels: { resolve: () => null } },
    guild: { roles: { resolve: () => null }, members: { resolve: (d) => (d?.id === BOT.id ? member : null), me: member } },
    everyone, repliedUser: null, users: new Set(users.map((u) => u.id)), parsedUsers: new Set(users.map((u) => u.id)), channels: new Set(), roles: roleMap,
  };
  return {
    guild: guild ? fake.guild : null,
    mentions: { has: (user, options) => MessageMentions.prototype.has.call(fake, user, options), roles: roleMap },
  };
}

test('a direct @mention of the bot is addressed to it', () => {
  assert.equal(isAddressedToBot(message({ users: [BOT] }), BOT), true);
});

test('@everyone / @here do not make the bot answer', () => {
  assert.equal(isAddressedToBot(message({ everyone: true }), BOT), false);
});

test('@everyone together with a real @bot mention still counts', () => {
  assert.equal(isAddressedToBot(message({ everyone: true, users: [BOT] }), BOT), true);
});

test('pinging a role the bot merely belongs to does not make it answer', () => {
  assert.equal(isAddressedToBot(message({ roles: [OTHER_ROLE], botRoles: [OTHER_ROLE] }), BOT), false);
});

test('the bot\'s own managed role counts as addressing it', () => {
  assert.equal(isAddressedToBot(message({ roles: [BOT_MANAGED_ROLE] }), BOT), true);
});

test('DMs are always addressed to the bot; unrelated messages are not', () => {
  assert.equal(isAddressedToBot(message({ guild: false }), BOT), true);
  assert.equal(isAddressedToBot(message(), BOT), false);
});

test('the bot\'s messages carry no mention permissions except the reply notification', () => {
  const client = new Client({ intents: [], allowedMentions: ALLOWED_MENTIONS });
  const channel = Object.create(TextChannel.prototype);
  Object.defineProperty(channel, 'client', { value: client });
  const body = MessagePayload.create(channel, '@everyone @here <@&123> <@456> hello').resolveBody().body;
  assert.deepEqual(body.allowed_mentions, { parse: [], replied_user: true });
});

test('an echoed command name cannot close the code block or carry a mention', () => {
  assert.equal(safeName('```@everyone'), 'everyone'); // the backticks and @ are gone
  assert.equal(safeName('<@&123>'), '123');
  assert.equal(safeName('help`\n@here'), 'helphere');
  assert.equal(safeName('a'.repeat(100)).length, 30);
  assert.equal(safeName('reset-all_2'), 'reset-all_2');
  const reply = `Unknown command: --${safeName('```@everyone')}\nType --help to see all commands.`;
  assert.equal(reply.includes('`'), false);
  assert.equal(reply.includes('@'), false);
});
