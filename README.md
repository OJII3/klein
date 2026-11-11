# Klein

Pi-based communication agent for Discord.

## Quick start

Requires [Nix](https://nixos.org/) with flakes enabled, or Bun 1.4.4+.

```sh
nix develop          # optional: provides Bun, cloudflared, and gcloud
bun install

cp config/config.example.json config/config.jsonc
cp .env.example .env
```

Set `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, and provider API keys in `.env`, then configure access rules and models in `config/config.jsonc`.

```sh
bun run start
```

`bun run start` builds the web UI and server, then runs the bot. It resumes the latest session for each Discord channel by default; pass `-- --new` to start fresh or `-- --resume` to be explicit.

Session history and rotation state are stored in `<runtime.agentDir>/sessions` and `<runtime.agentDir>/channel-sessions` (existing `pi-durable` SQLite databases are migrated automatically on startup). `bun run build`, `bun run build:web`, and `bun run build:server` are also available.

## Profiles

Profiles live in `config/<profile>/` and define the agent's personality and skills:

- `SOUL.md` — text chat prompt
- `SOUL.voice.md` — voice chat prompt
- `skills/` — profile-specific skills

Select one with `"profile"` in `config/config.jsonc` (default: `klein`). The bundled `yachiyo` profile is based on [YacchoGPT](https://github.com/tsukumijima/YacchoGPT) (CC0-1.0).

## Features

### Discord

- **Access control** — `discord.access` sets `default` and `directMessages` in `config/config.jsonc`, while `<runtime.agentDir>/discord-access.json` holds the guild, channel, and thread rules. Rules are evaluated thread → channel → guild → default. The bot owner can always send direct messages, and owner direct messages use owner features regardless of `directMessages`. When the bot is mentioned in a channel or thread that is not allowed, it posts a pending notice there and sends the owner a DM with allow and deny buttons; the choice is written back to `discord-access.json` and takes effect immediately. Pending requests are stored in `<runtime.agentDir>/discord-access-requests.json`, so the owner's buttons keep working after a restart. Manual edits are read at startup, so restart Klein after editing the file by hand. The Discord **Message Content Intent** is required.
- **Commands** — `/status idle` pauses message processing and `/status online` resumes it (Manage Server only). `/channels` lists the channels and threads that the access rules explicitly allow in the current guild, with their resolved levels (`allow`, `owner`).
- **Activity status** — shows remaining OpenCode Go, Google, or Mistral budget usage, refreshed hourly.

### LLM providers

- Supports OpenCode Go (`opencode-go`), Google Gemini (`google`, `GEMINI_API_KEY`), and Mistral (`mistral`, `MISTRAL_API_KEY`).
- **Google and Mistral** — the activity status reports the current month's spend. Spend is read from the opencode-usage API (`USAGE_ENDPOINT` and `USAGE_TOKEN`) when configured, and falls back to an estimate from local session usage otherwise.
- **Usage reporting** — when the opencode-usage API is configured, Klein sends each completed provider request's token counts and cost to `POST <USAGE_ENDPOINT>`. This makes the spend total cover both Klein and opencode. Prompts, completions, tool arguments, and tool output are not sent.
- **Context window** — `llm.contextWindowRatio` (`0.01`–`1.0`) caps context usage for automatic compaction. `llm.compaction.backgroundTokens` sets the token count before the blocking threshold at which background compaction starts (default `32768`; `0` starts it at the blocking threshold).
- **Image analysis** — `llm.image` configures a separate one-shot vision model whose analysis is added to the main conversation.

### Voice chat and TTS

- **Voice chat** — local Silero VAD (ONNX Runtime Web WASM) plus WebSocket ASR. See [`docs/voice-chat-asr-protocol.md`](docs/voice-chat-asr-protocol.md).
- **TTS** — external Style-Bert-VITS2 server via `features.tts.serverUrl`; provides the `discord_voice` tool and voice chat output. See [`docs/sbv2-tts-protocol.md`](docs/sbv2-tts-protocol.md).
- **Voice reactions** — `features.voiceChat.reactions` plays short acknowledgments while the full answer is generated. Generate presets with `bun scripts/generate-voice-presets.ts [manifest-path]`.

### Memory

With `features.memory.enabled`, Klein periodically extracts durable guild facts and notes from recent conversations into `.runtime/memory/{guildId}/MEMORY.json` using an optional background model.

Memory entries are stored together per guild and carry a scope: `guild`, `channel`, or `thread`. Extraction defaults to the conversation's channel and only promotes an entry to the guild when the fact applies server-wide. Retrieval always includes guild entries and adds channel or thread entries only at the matching location.

With `features.userMemory.enabled`, Klein keeps one Markdown file per Discord user under `<runtime.agentDir>/user-memory/{userId}.md` (or `features.userMemory.directory`), where `{userId}` is the numeric Discord user ID. The YAML front matter holds `discord_id` (the user-set username, the part after `@`), `display_name`, `nickname`, `first_name`, `last_name`, `summary`, `impression`, and `updated_at`; `impression` is an integer from -100 to 100 with 0 neutral. The body has the sections Facts, History, In common, and Strengthening. Facts should contain only confirmed facts, with `不明` for unknown values, and dates such as birthdays and anniversaries use `- <key>: YYYY-MM-DD` (for example `- birthday: 2000-01-02`). Klein creates the file as soon as it handles a message from a user, then a background agent with `features.userMemory.llm` (default: `llm`) reads and updates the file with its read, write, and edit tools after the conversation goes idle. The background agent never changes `display_name` or `impression`. The `user_memory_get` tool takes the `@username` shown in messages and resolves it to the numeric user ID through `<runtime.agentDir>/discord-users.json`, a shared directory built from users Klein has seen in messages; only users who have spoken or appeared as a reply author can be resolved. Memory updates happen only in the background, and user memory is not injected into the conversation automatically and cannot be searched by display name.

### Scheduling

Reminders and watches share `<runtime.agentDir>/schedules`. Each item belongs to a Discord channel or thread and survives session rotation; delivery rechecks current access rules and owner ID, and items that are no longer allowed stay stored but are not delivered. Recurring items are rescheduled and one-time items are skipped for the rest of the process, so a denied item is not rechecked every check interval.

- **Reminders** send a fixed message once or on a recurring schedule (`every` minutes, daily, or weekly), scoped to `public` or `owner:<userId>`.
- **Watches** run a QuickJS script on a recurring schedule. Each check ends with `wake()` to notify the agent or `silent()` to do nothing, and `store()` / `load()` keep JSON values between checks. Checks time out after 30 seconds, use at most 64 MiB of sandbox memory, and are limited to 64 KiB of output; failures are recorded in `watch_list` and do not wake the agent. `watch_add` runs the script once before registering it, and enabling a disabled watch with `watch_update` runs the script once before enabling it; if that run fails, the watch is not registered or stays disabled, and `store()` writes from the run are discarded. `watch_update` edits a watch and can disable it with `enabled: false`; disabled watches keep their settings but are not checked, and re-enabling schedules the next check from the update time. `watch_get` returns one watch with its script and args.

Watch scripts read the `args` array, call the tools listed in the `watch` prompt section with `tools.<name>({ ...args })`, and print with `text()` or `console.*`. The section is rendered from the watch tool catalog and appears only while `watch_add` is offered. It currently exposes `tools.fetch_content({ url, urls?, mode? })`, a read-only, GET-only subset of the session's fetch tool (`mode` is `raw` or `readable`; `auth`, `proxy`, `answer`, `extract`, and video are unavailable).

The sandbox has no timers, filesystem, process APIs, or persistent storage (`store` and `load` are rejected), and normal session tools are not available inside watch scripts. The printed text and returned value form the output.

Schedules use a unified format; the old `<runtime.agentDir>/reminders` directory is ignored.

### Remote MCP tools

Register MCP tools in Pi's agent directory (`.runtime/pi`):

```sh
PI_CODING_AGENT_DIR=.runtime/pi bunx pi mcp add docs --url https://mcp.example.com/mcp --exposure deferred
```

For a server that returns 401, authenticate after `bun run build:server`:

```sh
bun dist/klein mcp login docs
```

The callback is served on `127.0.0.1` and the authorization URL is printed. If the browser runs on another machine, paste the redirected URL instead. Credentials are stored in `<runtime.agentDir>/mcp-auth.json`; set `oauth.callbackPort` or `oauth.callbackUrl` in `mcp.json` when the OAuth client has a fixed redirect URI. Restart Klein after changing MCP configuration.

### Owner access

Locations and tools can be restricted with `owner` in addition to `allow` and `deny`. Owner locations accept only the bot owner, use isolated session history, and do not write to shared guild memory. Tools and MCP servers marked `owner` run only in owner conversations.

### Web UI

An optional dashboard for Pino logs, Pi sessions, memories, and tool usage. Enable it in `config/config.jsonc`:

```jsonc
{
  "features": {
    "webui": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 4310,
    },
  },
}
```

Open `http://127.0.0.1:4310` after starting Klein.

Pi sessions are labeled with their Discord channel name. Klein records the name in each channel's session state when it handles a message and refreshes known channels at startup, so the dashboard does not call the Discord API per request. The mapping is also available from `GET /api/channels`.

The **ツール** view counts every tool execution stored in Pi session history, both per tool and per MCP server. Counts include calls made from codemode scripts and do not reset when Klein restarts.

The **メモリ** view lists owner, guild, and per-user Discord memories. Owner and guild memories accept new rules and entry deletions. User memories are shown read-only from the Markdown files Klein updates in the background, and the user list can be filtered by display name, username, numeric user ID, and summary.

For frontend development, run the bot as usual and start Vite separately:

```sh
bun run dev:web
```

Vite serves the UI on `http://127.0.0.1:5173` and proxies `/api` to port 4310. The production build is written to `dist/web` and served by the Elysia app.

To expose it through Cloudflare Tunnel, add `TUNNEL_TOKEN` to `.env` and protect the route with Cloudflare Access. `cloudflared` starts and stops with Klein.
