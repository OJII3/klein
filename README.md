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

The Discord agent's personality and behavior are loaded from the Markdown file
configured by `agents.discord.systemPromptFile` (`config/SOUL.md` by default).

Logs are written as JSON lines to standard output and to the `pino` directory
under `runtime.logDir` (`.runtime/logs/pino` by default). Set
`KLEIN_LOG_LEVEL=debug` when investigating the bot locally; the default level
is `info`. Log records do not include Discord message content, prompts, or API
credentials.

## Run the log and session viewer

The optional read-only Web UI shows persisted Pino logs and Pi session history.
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
      "enabled": false
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

To register the OpenCode Go usage slash command, set `DISCORD_APPLICATION_ID` in `.env` and run:

```sh
bun run register:discord-commands
```

The command is registered to every guild listed in `discord.access.guilds` in `config/klein.json`.
It is not registered globally or in DMs. Use `/limit` in Discord to view the monthly usage percentage
and reset time.
