# Klein

Pi Coding Agent Based Communication Agent.

## Run the Discord bot

Enter the Nix development shell and install dependencies:

```sh
nix develop
bun install
```

The Web UI is bundled into `dist/web` and served as static files by Elysia.
`bun run start` builds the frontend automatically before starting Klein.

Copy the configuration and environment templates, fill in the Discord access
rules, bot token, and OpenCode Go API key, then start it:

```sh
cp config/klein.example.json config/klein.json
cp .env.example .env
${EDITOR:-vi} .env
${EDITOR:-vi} config/klein.json
bun run start
```

By default, Klein resumes the latest Pi session for each Discord channel. Use
`--new` to start fresh sessions for the next run, or `--resume` to make the
default behavior explicit:

```sh
bun run start -- --new
bun run start -- --resume
```

The application uses OpenCode Go through Pi's `opencode-go` provider. Pi's
runtime data is stored in the directory configured by `runtime.agentDir`
(`.runtime/pi` by default), including the per-channel session history. Set
`KLEIN_CONFIG_PATH` only when you need to use a different configuration file.

The `llm.model` and optional `llm.thinkingLevel` settings are used by the main
Pi session. The optional `llm.image` setting configures a separate, one-shot
image analysis model. When it is configured, image attachments are sent only
to that model; its text analysis is provided to the main session as context,
which keeps the final response in the main model's voice. The image model must
support image input.

To use an Exa API key with `pi-web-access`, optionally set `EXA_API_KEY` in `.env`.

## Delegate workspace changes to Codex app server

Klein can expose a `codex_delegate` tool to the Discord agent. The tool connects
to an already-running Codex app server through its Unix socket and delegates
workspace edits, tests, and small tool implementations without exposing a
local shell tool to the Discord agent.

Enable it in `config/klein.json`:

```json
{
  "features": {
    "codexAppServer": {
      "enabled": true,
      "socketPath": "/home/your-user/.codex/app-server-control/app-server-control.sock",
      "codexHome": "/home/your-user/.codex",
      "workspace": "/home/your-user/src/klein",
      "timeoutSeconds": 900
    }
  }
}
```

The app server must already be listening on the configured Unix socket. Klein
performs the Unix-domain WebSocket handshake itself and exchanges
newline-delimited JSON-RPC messages over the connection. The Codex CLI is
needed for type generation, but is not started for each delegation.

`workspace` is the default project. `codexHome` points to the Codex home whose
`config.toml` contains the `[projects."..."]` entries. If omitted, Klein uses
`$CODEX_HOME` or `~/.codex`. Those Codex project entries are listed by
`codex_projects` (this is read from the local Codex config; it is not an
app-server project-list RPC); `codex_delegate` accepts a project path from
that list and starts the Codex task in the background. The tool returns immediately;
completion, failure, timeout, or cancellation is posted to the current Discord
channel. `codex_task_status` can check tasks while Klein is running.

The protocol types used by the client are generated from the installed Codex
CLI:

```sh
bun run generate:codex-types
```

This copies only the stable type dependency closure needed by Klein into
`src/modules/codex-app-server/protocol/generated/`. Keep the generated types
in sync with the Codex CLI version used by the app server.

See `config/skills/codex-app-server/SKILL.md` for how to formulate delegation
tasks and the safety boundary.

The Discord agent's personality and behavior are loaded from the Markdown file
configured by `agents.discord.systemPromptFile` (`config/SOUL.md` by default).

When `features.memory.enabled` is true, Klein periodically extracts durable
guild-wide facts, rules, decisions, and procedures from recent Discord
messages in the background. The default path is
`.runtime/memory/{guildId}/MEMORY.md`; `{guildId}` is replaced for each guild.
The memory model is optional and inherits `llm` when omitted. When configured,
it is a separate one-shot model and does not share the Discord agent session.

Logs are written as JSON lines to standard output and to the `pino` directory
under `runtime.logDir` (`.runtime/logs/pino` by default). Set
`KLEIN_LOG_LEVEL=debug` when investigating the bot locally; the default level
is `info`. Log records do not include Discord message content, prompts, or API
credentials.

## Run the Web UI viewer

The optional read-only Web UI shows persisted Pino logs, Pi session history, and
guild memory contents. The memory tab lists guilds with persisted memory and
shows each entry's kind, title, body, timestamps, and source message count.
Update the `runtime` and `features` sections in `config/klein.json` (other
required sections are omitted here):

```json
{
  "runtime": {
    "agentDir": ".runtime/pi",
    "logDir": ".runtime/logs"
  },
  "features": {
    "memory": {
      "enabled": true,
      "filePath": ".runtime/memory/{guildId}/MEMORY.md",
      "llm": {
        "provider": "opencode-go",
        "model": "deepseek-v4-flash",
        "thinkingLevel": "low"
      },
      "idleSeconds": 180,
      "maxBatchAgeSeconds": 1800,
      "maxBatchMessages": 32
    },
    "minecraft": {
      "enabled": false
    },
    "webui": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 4310
    }
  }
}
```

Start Klein, then open `http://127.0.0.1:4310`. Keep the host bound
to loopback when exposing the viewer through a ZeroTrust tunnel. The UI is
disabled by default and does not provide write operations.

For an ahead-of-time production bundle, run `bun run build` and execute it with
`bun dist/klein`, keeping the generated `dist/web/` directory available from
the working directory. The frontend is not served with HMR:

bun run start
The same Elysia server provides the API and the bundled UI.

The bot responds to direct and guild messages when allowed by `discord.access`.
Guild access is resolved in the order
thread → channel → guild → default, while direct messages use
`directMessages`. The Discord application must have the Message Content intent
enabled.

Members with the Manage Server permission can use `/idle` to pause new message
processing and `/online` to resume it. Messages already being processed are
allowed to finish. The operating mode is kept in memory and starts as active
after each restart.

The bot's Discord activity displays the remaining OpenCode Go monthly usage and reset countdown, for
example `65.5%/month (reset in 17 days)`. It is refreshed hourly.
