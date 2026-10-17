# ollama-discord

Discord bot that answers with a local Ollama model (`qwen2.5:7b`).

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

## Web search (MCP)
The bot connects to an MCP search server and lets the model call it when it needs current info. Default is `@oevortex/ddg_search` (no key, but DuckDuckGo may block/rate-limit it). For reliable results use Brave Search: see the `MCP_*` examples in `.env.example`. Set `MCP_ENABLED=false` to disable.

## Web dashboard
Open http://127.0.0.1:8787 while the bot is running to change the model (from your installed Ollama models), system prompt, history length, context size, search on/off, pause the bot, clear history, and see recent activity. Changes apply immediately and are saved to `config.json` (which overrides `.env`; delete it to go back to `.env` values).

- Local only by default. To reach it from another machine set `WEB_HOST` and a `WEB_PASSWORD` (the dashboard refuses to start on a non-local address without one). Use HTTPS or a VPN in front of it, since Basic auth is not encrypted.
- The Discord token, Ollama address and MCP command stay in `.env` and cannot be changed from the web, so a compromised dashboard can't run commands on your machine.
