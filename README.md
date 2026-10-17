# ollama-discord

Discord bot that answers with a local Ollama model (`qwen2.5:3b`).

## Setup
1. Install Ollama (https://ollama.com) and pull the model:
   ```
   ollama pull qwen2.5:3b
   ```
2. Create a bot at https://discord.com/developers/applications, enable **Message Content Intent** (Bot tab), copy the token, and invite it with the `bot` scope and Send Messages / Read Message History permissions.
3. Configure and run:
   ```
   npm install
   cp .env.example .env   # set DISCORD_TOKEN
   npm start
   ```

## Usage
- @mention the bot in a server channel, or DM it.
- `!reset` (after mention/in DM) clears that channel's conversation history.

Config via `.env`: `OLLAMA_HOST`, `OLLAMA_MODEL`, `SYSTEM_PROMPT`, `HISTORY_LIMIT`.
