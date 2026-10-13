# Klein

Pi-based communication agent for Discord.

## Quick Start

### 1. Requirements & Installation

Enter the Nix development shell (or ensure Bun is installed) and install dependencies:

```sh
nix develop
bun install
```

### 2. Configuration

Copy the example configuration and environment files:

```sh
cp config/config.example.json config/config.jsonc
cp .env.example .env
${EDITOR:-vi} .env
${EDITOR:-vi} config/config.jsonc
```

Fill in your Discord bot token and access rules in `config/config.jsonc` and `.env`. Set provider API keys as needed (e.g. `GOOGLE_CLOUD_API_KEY` for Vertex AI, `OPENCODE_API_KEY` for OpenCode Go).

### 3. Run

`bun run start` builds both the web frontend and server, then starts the bot:

```sh
bun run start
```

By default, Klein resumes the latest session for each Discord channel. Use flags to control session resumption:

```sh
bun run start -- --new     # Start fresh sessions
bun run start -- --resume  # Explicitly resume sessions (default)
```

Separate build commands are also available:

- `bun run build` (builds both server and web UI)
- `bun run build:web` / `bun run build:server`

## Profiles

Profiles define agent personality and skills in `config/<profile>/`:

- `SOUL.md`: Discord text chat prompt.
- `SOUL.voice.md`: Voice chat prompt (used when voice chat is active).
- `skills/`: Profile-specific skills.

Set `"profile"` in `config/config.jsonc` to switch profiles (defaults to `"klein"`). An included `"yachiyo"` profile is available based on [YacchoGPT](https://github.com/tsukumijima/YacchoGPT) (CC0-1.0).

## Features

### Discord Bot & Commands

- **Access control**: Configured via `discord.access` (evaluated in order: thread → channel → guild → default). Requires the Discord **Message Content Intent**.
- **Commands**: Members with _Manage Server_ permissions can use `/idle` to pause message processing and `/online` to resume.
- **Activity status**: Displays remaining monthly usage and estimated cost, refreshed hourly.

### LLM & Providers

- Supports OpenCode Go (`opencode-go`) and Google Cloud Vertex AI Express Mode (`google-vertex`).
- **Context window**: Adjust `llm.contextWindowRatio` (`0.01`–`1.0`) to cap context window usage for automatic compaction.
- **Image analysis**: Configure `llm.image` to use a separate one-shot vision model; its analysis is passed to the main conversation context.

### Voice Chat & TTS

- **Voice chat**: Powered by a bundled local Silero VAD (ONNX Runtime Web WASM) and WebSocket ASR. See [`docs/voice-chat-asr-protocol.md`](docs/voice-chat-asr-protocol.md).
- **TTS**: Connects to an external Style-Bert-VITS2 (SBV2) server via `features.tts.serverUrl`. Provides the `discord_voice` tool and voice chat output. See [`docs/sbv2-tts-protocol.md`](docs/sbv2-tts-protocol.md).
- **Voice reactions**: Set `features.voiceChat.reactions` to trigger short audio acknowledgments while generating full answers. Generate audio files from a manifest with:
  ```sh
  bun scripts/generate-voice-presets.ts [manifest-path]
  ```

### Memory

When `features.memory.enabled` is true, Klein periodically extracts durable guild facts and notes from recent conversations into `.runtime/memory/{guildId}/MEMORY.md` using an optional background model.

### Political content check

Set `features.politicalContentCheck.enabled` to `true` to skip political Discord text and voice transcripts (including neutral factual questions and China-related topics such as the 1989 Tiananmen Square protests and massacre) before the chat model and guild memory. Uncertain classifications are also skipped. Configure a separate classifier model; it receives the text for evaluation. Voice transcripts are checked after local transcription. Image attachments are outside this check.

### Remote MCP Tools

Register MCP tools directly into Pi's agent directory (`.runtime/pi`):

```sh
PI_CODING_AGENT_DIR=.runtime/pi bunx pi mcp add docs --url https://mcp.example.com/mcp --exposure deferred
PI_CODING_AGENT_DIR=.runtime/pi bunx pi mcp login docs
```

Restart Klein after modifying MCP configurations.

### Web UI Viewer

An optional dashboard to inspect Pino logs, Pi sessions, and guild memories.

Enable it in `config/config.jsonc`:

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

#### Cloudflare Tunnel (Optional)

To securely expose the Web UI:

1. Create a Cloudflare Tunnel and add `TUNNEL_TOKEN=...` to `.env`.
2. Protect the route with Cloudflare Access.
3. Start Klein (`cloudflared` is started and stopped automatically with Klein).
