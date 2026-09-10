# Klein

Pi Coding Agent Based Communication Agent.

## Run the Discord bot

Enter the Nix development shell, install dependencies, and build the bot:

```sh
nix develop
pnpm install
pnpm run build
```

Copy the configuration and environment templates, fill in the Discord access
rules, bot token, and OpenCode Go API key, then start it:

```sh
cp config/klein.example.json config/klein.json
cp .env.example .env
${EDITOR:-vi} .env
${EDITOR:-vi} config/klein.json
pnpm start
```

By default, Klein resumes the latest Pi session for each Discord channel. Use
`--new` to start fresh sessions for the next run, or `--resume` to make the
default behavior explicit:

```sh
pnpm start -- --new
pnpm start -- --resume
```

The application uses OpenCode Go through Pi's `opencode-go` provider. Pi's
runtime data is stored in the directory configured by `runtime.agentDir`
(`.runtime/pi` by default), including the per-channel session history. Set
`KLEIN_CONFIG_PATH` only when you need to use a different configuration file.

The `llm.model` and optional `llm.thinkingLevel` settings are passed directly
to each Pi session.

The Discord agent's personality and behavior are loaded from the Markdown file
configured by `agents.discord.systemPromptFile` (`config/SOUL.md` by default).

Logs are written as JSON lines to standard output. Set `KLEIN_LOG_LEVEL=debug`
when investigating the bot locally; the default level is `info`. Log records do
not include Discord message content, prompts, or API credentials.

The bot responds to direct and guild messages when allowed by `discord.access`.
Guild access is resolved in the order
thread → channel → guild → default, while direct messages use
`directMessages`. The Discord application must have the Message Content intent
enabled.
