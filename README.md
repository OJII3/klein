# Klein

Pi Coding Agent Based Communication Agent.

## Run the Discord bot

Enter the Nix development shell, install dependencies, and build the bot:

```sh
nix develop
pnpm install
pnpm run build
```

Set a Discord bot token and a provider API key, then start it:

```sh
DISCORD_BOT_TOKEN=... ANTHROPIC_API_KEY=... pnpm start
```

The bot responds to direct messages and guild messages that mention it. The
Discord application must have the Message Content intent enabled.
