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

The application uses OpenCode Go through Pi's `opencode-go` provider. Pi's
runtime data is stored in the directory configured by `runtime.agentDir`
(`.runtime/pi` by default). Set `KLEIN_CONFIG_PATH` only when you need to use
a different configuration file.

The `llm.model` and optional `llm.thinkingLevel` settings are passed directly
to each Pi session.

The bot responds to direct messages and guild messages that mention it when
allowed by `discord.access`. Guild access is resolved in the order
thread → channel → guild → default, while direct messages use
`directMessages`. The Discord application must have the Message Content intent
enabled.
