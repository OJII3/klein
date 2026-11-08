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

- **Access control** — `discord.access` is evaluated thread → channel → guild → default. The Discord **Message Content Intent** is required.
- **Commands** — `/status idle` pauses message processing and `/status online` resumes it (Manage Server only).
- **Activity status** — shows remaining OpenCode Go, Google, or Mistral budget usage, refreshed hourly.

### LLM providers

- Supports OpenCode Go (`opencode-go`), Google Gemini (`google`, `GEMINI_API_KEY`), and Mistral (`mistral`, `MISTRAL_API_KEY`).
- **Google and Mistral** — the activity status reports the current month's spend. Google spend is estimated from local session usage; Mistral spend is read from Langfuse (`LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`, matched by model name) when configured, and falls back to the local estimate otherwise.
- **Context window** — `llm.contextWindowRatio` (`0.01`–`1.0`) caps context usage for automatic compaction. `llm.compaction.backgroundTokens` sets the token count before the blocking threshold at which background compaction starts (default `32768`; `0` starts it at the blocking threshold).
- **Image analysis** — `llm.image` configures a separate one-shot vision model whose analysis is added to the main conversation.

### Voice chat and TTS

- **Voice chat** — local Silero VAD (ONNX Runtime Web WASM) plus WebSocket ASR. See [`docs/voice-chat-asr-protocol.md`](docs/voice-chat-asr-protocol.md).
- **TTS** — external Style-Bert-VITS2 server via `features.tts.serverUrl`; provides the `discord_voice` tool and voice chat output. See [`docs/sbv2-tts-protocol.md`](docs/sbv2-tts-protocol.md).
- **Voice reactions** — `features.voiceChat.reactions` plays short acknowledgments while the full answer is generated. Generate presets with `bun scripts/generate-voice-presets.ts [manifest-path]`.

### Memory

With `features.memory.enabled`, Klein periodically extracts durable guild facts and notes from recent conversations into `.runtime/memory/{guildId}/MEMORY.json` using an optional background model.

Memory entries are stored together per guild and carry a scope: `guild`, `channel`, or `thread`. Extraction defaults to the conversation's channel and only promotes an entry to the guild when the fact applies server-wide. Retrieval always includes guild entries and adds channel or thread entries only at the matching location.

### Scheduling

Reminders and watches share `<runtime.agentDir>/schedules`. Each item belongs to a Discord channel or thread and survives session rotation; delivery rechecks current access rules and owner ID, and items that are no longer allowed stay stored but are not delivered. Recurring items are rescheduled and one-time items are skipped for the rest of the process, so a denied item is not rechecked every check interval.

- **Reminders** send a fixed message once or on a recurring schedule (`every` minutes, daily, or weekly), scoped to `public` or `owner:<userId>`.
- **Watches** run a QuickJS script on a recurring schedule and wake the agent only when the output changes. The first successful check sets the baseline; `condition: "output"` notifies on any output. Checks time out after 30 seconds, use at most 64 MiB of sandbox memory, and are limited to 64 KiB of output; failures are recorded in `watch_list` and do not wake the agent.

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

An optional dashboard for Pino logs, Pi sessions, guild memories, and tool usage. Enable it in `config/config.jsonc`:

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

The **ツール** view counts every tool execution stored in Pi session history, both per tool and per MCP server. Counts include calls made from codemode scripts and do not reset when Klein restarts.

For frontend development, run the bot as usual and start Vite separately:

```sh
bun run dev:web
```

Vite serves the UI on `http://127.0.0.1:5173` and proxies `/api` to port 4310. The production build is written to `dist/web` and served by the Elysia app.

To expose it through Cloudflare Tunnel, add `TUNNEL_TOKEN` to `.env` and protect the route with Cloudflare Access. `cloudflared` starts and stops with Klein.
