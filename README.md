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
- Commands (type after the @mention, or in a DM). Replies come in a code block, and `--help` always lists the current commands:
  - `--help` lists all commands
  - `--info` shows the model, tools, your conversation size, uptime and average reply time
  - `--reset` clears your own conversation history
- Each person gets their own conversation, even in a shared channel, so two people chatting at once don't mix. `--reset` clears your own history. To share one conversation per channel instead, set `HISTORY_SCOPE=channel` in `.env` or change "History kept" in the dashboard.

Config via `.env`: `OLLAMA_HOST`, `OLLAMA_MODEL`, `SYSTEM_PROMPT`, `HISTORY_LIMIT`.

## Web search (MCP)
The bot connects to an MCP search server and lets the model call it when it needs current info; it then reads the top result and answers with a short summary and a source link.

**Recommended: local SearXNG (free, no API key, needs Docker)**
```
./searxng/setup.sh        # first-time setup; later ./bot.sh start/stop handles it (http://127.0.0.1:8888, local only)
```
Then put this in `.env` and run `./bot.sh restart`:
```
SEARXNG_URL=http://127.0.0.1:8888
```
`./bot.sh start` starts SearXNG automatically (opening Docker Desktop if needed) and `./bot.sh stop` stops it again, as long as `SEARXNG_URL` is set in `.env`. SearXNG combines several engines; if some are blocked at your IP it uses the others.

Set `MCP_ENABLED=false` to disable search and other tools.

## Web dashboard
Open http://127.0.0.1:8787 while the bot is running to change the model (from your installed Ollama models), system prompt, history length, context size, temperature, max tool rounds, which **MCP servers** the bot uses, tools on/off, advanced model options (top-p, max reply tokens, keep-alive), which channels the bot answers in, a per-user cooldown, the bot's Discord status text, pause the bot, clear history, and see recent activity. Changes apply immediately and are saved to `config.json` (which overrides `.env`; delete it to go back to `.env` values).

![Settings tab: model, system prompt, limits and controls](docs/screenshots/settings.png)

| MCP tools | Activity and token usage |
| --- | --- |
| ![MCP tools tab: choose which MCP servers the bot uses](docs/screenshots/tools.png) | ![Activity tab: recent messages with tokens in and out](docs/screenshots/activity.png) |

*Screenshots use demo data.*

### Monitor tab
Shows how the bot is performing: health warnings (swap nearly full, model partly on CPU, slow replies, prompts filling the context, repeated tool loops), averages (reply time, tokens/s for reading and writing, model calls per reply), a chart of where each reply's time went (model load, reading the prompt, writing the answer, tools), how much memory Ollama's model uses, and swap/CPU load on the Mac. Reply data is kept in memory for the last 50 replies and resets on restart.

### Logs
The bot keeps two logs on disk in `logs/` (git-ignored), so you can investigate problems after the fact:
- `logs/bot.jsonl`: everything the bot prints (startup, tool calls, warnings, errors, crashes), one JSON object per line.
- `logs/chat.jsonl`: each question and answer with user, timing, tokens, tools used and any error. Turn this off with "Save chat log to disk" in Settings if you don't want conversations stored.

Each file rotates at 2 MB and keeps two older copies (`.1`, `.2`), so disk use stays small. The Monitor tab's **Logs** card shows both, with filters (all / warnings and errors / errors only), text search, click-to-expand rows and a Clear button, and the Health box warns when the bot log has errors from the last hour. The Discord token is scrubbed if it ever appears. `bot.log` (raw console output from `./bot.sh`) is still written as before.

### Choosing the bot's MCP servers
The "MCP servers" list shows every server the bot knows about with a live status (off / connecting / connected / error) and the tools each one provides. Tick the ones you want and press Save; servers are started or stopped right away, and **Reconnect failed servers** retries any that errored. Several servers can run at once. If two expose a tool with the same name, the later one is prefixed with its id (e.g. `fake__get_time`).

The list comes from three places (later wins on the same id):
1. built in: `searxng` (needs `SEARXNG_URL` in `.env`; the dashboard shows what is missing)
2. `env` (optional, older way): one server described by `MCP_COMMAND` / `MCP_ARGS` / `MCP_ENV_KEYS` in `.env`. Only appears if `MCP_COMMAND` is set; don't set it for SearXNG, as that would duplicate the built-in `searxng` entry and double every search tool in the prompt. If set, it is selected by default, otherwise `searxng` is
3. your own `mcp-servers.json` (copy `mcp-servers.example.json`; re-read when the file changes, no restart needed):
   ```json
   { "servers": [ { "id": "time", "label": "Time", "description": "...", "command": ".venv/bin/mcp-server-time", "args": ["--local-timezone=Asia/Bangkok"], "envKeys": [] } ] }
   ```
   `envKeys` lists the `.env` variables forwarded to that server; nothing else from `.env` (such as the Discord token) is passed on.

**Time server (current date, time and timezones).** The official `mcp-server-time` is a Python package, so it lives in its own virtual environment inside the project (git-ignored, along with your `mcp-servers.json`):
```
python3 -m venv .venv && .venv/bin/pip install mcp-server-time
cp mcp-servers.example.json mcp-servers.json   # adjust --local-timezone if you are not in Asia/Bangkok
```
Then tick **Time** in the dashboard's MCP tools tab and Save. It provides `get_current_time` and `convert_time`, so date questions are answered instantly instead of by web search. Tell the bot to use it in the system prompt, for example: "For the current date or time, or timezone questions, use the time tool (default timezone Asia/Bangkok). Use web search only for other current events."

Search-style tools (name contains `web-search` / `web_search`) get the summarise-and-cite flow; every other tool is offered to the model as is.

- Local only by default. To reach it from another machine set `WEB_HOST` and a `WEB_PASSWORD` (the dashboard refuses to start on a non-local address without one). Use HTTPS or a VPN in front of it, since Basic auth is not encrypted.
- The Discord token, Ollama address and MCP commands stay on the server (`.env`, built-ins, `mcp-servers.json`). The dashboard can only pick servers by id, so a compromised dashboard can't make the bot run a new command. Only add servers to `mcp-servers.json` that you trust: they run as your user.
