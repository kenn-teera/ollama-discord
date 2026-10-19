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
- Each person gets their own conversation, even in a shared channel, so two people chatting at once don't mix. `!reset` clears your own history. To share one conversation per channel instead, set `HISTORY_SCOPE=channel` in `.env` or change "History kept" in the dashboard.

Config via `.env`: `OLLAMA_HOST`, `OLLAMA_MODEL`, `SYSTEM_PROMPT`, `HISTORY_LIMIT`.

## Web search (MCP)
The bot connects to an MCP search server and lets the model call it when it needs current info; it then reads the top result and answers with a short summary and a source link.

**Recommended: local SearXNG (free, no API key, needs Docker)**
```
./searxng/setup.sh        # first-time setup; later ./bot.sh start/stop handles it (http://127.0.0.1:8888, local only)
```
Then put this in `.env` and run `./bot.sh restart`:
```
MCP_COMMAND=npx
MCP_ARGS=-y mcp-searxng
MCP_ENV_KEYS=SEARXNG_URL
SEARXNG_URL=http://127.0.0.1:8888
```
`./bot.sh start` starts SearXNG automatically (opening Docker Desktop if needed) and `./bot.sh stop` stops it again, as long as `SEARXNG_URL` is set in `.env`. SearXNG combines several engines; if some are blocked at your IP it uses the others.

Set `MCP_ENABLED=false` to disable search and other tools.

## Web dashboard
Open http://127.0.0.1:8787 while the bot is running to change the model (from your installed Ollama models), system prompt, history length, context size, temperature, max tool rounds, which **MCP servers** the bot uses, tools on/off, pause the bot, clear history, and see recent activity. Changes apply immediately and are saved to `config.json` (which overrides `.env`; delete it to go back to `.env` values).

### Choosing the bot's MCP servers
The "MCP servers" list shows every server the bot knows about with a live status (off / connecting / connected / error) and the tools each one provides. Tick the ones you want and press Save; servers are started or stopped right away, and **Reconnect failed servers** retries any that errored. Several servers can run at once. If two expose a tool with the same name, the later one is prefixed with its id (e.g. `fake__get_time`).

The list comes from three places (later wins on the same id):
1. built in: `searxng` (needs `SEARXNG_URL` in `.env`; the dashboard shows what is missing)
2. `env`: the single server described by `MCP_COMMAND` / `MCP_ARGS` / `MCP_ENV_KEYS` in `.env`; if set it is selected by default, otherwise `searxng` is
3. your own `mcp-servers.json` (copy `mcp-servers.example.json`; re-read when the file changes, no restart needed):
   ```json
   { "servers": [ { "id": "time", "label": "Time", "description": "...", "command": "uvx", "args": ["mcp-server-time"], "envKeys": [] } ] }
   ```
   `envKeys` lists the `.env` variables forwarded to that server; nothing else from `.env` (such as the Discord token) is passed on.

Search-style tools (name contains `web-search` / `web_search`) get the summarise-and-cite flow; every other tool is offered to the model as is.

- Local only by default. To reach it from another machine set `WEB_HOST` and a `WEB_PASSWORD` (the dashboard refuses to start on a non-local address without one). Use HTTPS or a VPN in front of it, since Basic auth is not encrypted.
- The Discord token, Ollama address and MCP commands stay on the server (`.env`, built-ins, `mcp-servers.json`). The dashboard can only pick servers by id, so a compromised dashboard can't make the bot run a new command. Only add servers to `mcp-servers.json` that you trust: they run as your user.
