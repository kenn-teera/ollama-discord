// Never ping @everyone, @here or roles from the bot's replies. Model output (which can carry text from fetched pages) and echoed
// user text are not trusted. Replying still notifies the person being replied to.
export const ALLOWED_MENTIONS = { parse: [], repliedUser: true };

// User text echoed back in a reply (an unknown command name): letters, digits, - and _ only, at most 30 characters.
export const safeName = (text) => text.replace(/[^a-z0-9_-]/gi, '').slice(0, 30);

// Is this message addressed to the bot? In a server that means @bot (or the bot's own managed role). discord.js's default
// MessageMentions.has() is also true for @everyone/@here and for any pinged role the bot happens to be a member of, which made
// the bot answer every announcement.
export function isAddressedToBot(msg, botUser) {
  if (!msg.guild) return true; // a DM
  if (msg.mentions.has(botUser, { ignoreEveryone: true, ignoreRoles: true })) return true;
  const botRole = msg.guild.members.me?.roles.botRole;
  return Boolean(botRole && msg.mentions.roles.has(botRole.id));
}
