# Klein

Pi-based communication agent for Discord.

## Quick start

Requires [Nix](https://nixos.org/) with flakes enabled, or Bun 1.4.4+. Sandboxed user shells also require `bwrap` (bubblewrap) and `pasta` (passt) with unprivileged user namespaces and `/dev/net/tun`; the devShell includes both.

```sh
nix develop          # optional: provides Bun, cloudflared, agent-browser, bubblewrap, and passt
bun install

cp config/config.example.json config/config.jsonc
cp .env.example .env
```

Set `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, and provider API keys in `.env`, then configure access rules and models in `config/config.jsonc`.

```sh
bun run start
```

`bun run start` builds the web UI and server, then runs the bot. It resumes the latest session for each Discord channel by default; pass `-- --new` to start fresh or `-- --resume` to be explicit.

## Profiles

Profiles live in `config/<profile>/` and define the agent's personality and skills:

- `profile.json` — required metadata such as `{"name": "クライン"}` used for rotation handoff goals and voice chat announcements
- `SOUL.md` — text chat prompt
- `SOUL.voice.md` — voice chat prompt
- `skills/` — profile-specific skills

Select one with `"profile"` in `config/config.jsonc` (default: `klein`). The bundled `yachiyo` profile is based on [YacchoGPT](https://github.com/tsukumijima/YacchoGPT) (CC0-1.0).

## Worker shells

Owner workers run `bash` directly on the host in the owner's home, so they can use the host's repositories, dotfiles, and installed CLIs. Workers for other linked users run in the bubblewrap sandbox, limited to that user's workspace and home.

## Documentation

- [docs/voice-chat-asr-protocol.md](docs/voice-chat-asr-protocol.md) — ASR WebSocket protocol
- [docs/sbv2-tts-protocol.md](docs/sbv2-tts-protocol.md) — SBV2 HTTP protocol

## Development

```sh
bun fmt
bun lint:fix
bun test
bun run build        # or build:web and build:server individually
bun run dev:web      # Vite on 127.0.0.1:5173, proxies /api to 4310
```
