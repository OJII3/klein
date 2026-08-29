# Klein

Pi Coding Agent Based Communication Agent.

## Run the Discord bot

Enter the Nix development shell, install dependencies, and build the bot:

```sh
nix develop
pnpm install
pnpm run build
```

Copy the environment template, fill in the Discord bot token and OpenCode Go
API key, then start it:

```sh
cp .env.example .env
${EDITOR:-vi} .env
pnpm start
```

The application uses OpenCode Go through Pi's `opencode-go` provider. Pi's
runtime data is stored in `.runtime/pi` by default. Set
`PI_CODING_AGENT_DIR` only when you need to override that location.

The bot responds to direct messages and guild messages that mention it. The
Discord application must have the Message Content intent enabled.
