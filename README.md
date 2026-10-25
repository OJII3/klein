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

Conversation history, session-key bindings, and Discord daily rotation state are stored
through Pi Durable's document APIs in `<runtime.agentDir>/pi-durable/pi-durable.sqlite`.
A separately configured voice model uses `pi-durable-voice/pi-durable.sqlite` for its
conversations. Session keys are namespaced by the caller; each conversation receives
the caller's tools, filtered by the current permissions, when its runtime is created
or reattached.

Back up the SQLite databases to preserve session history and rotation state.

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
- **Commands**: Members with _Manage Server_ permissions can use `/status idle` to pause message processing and `/status online` to resume.
- **Activity status**: Displays remaining monthly usage and estimated cost, refreshed hourly.

### LLM & Providers

- Supports OpenCode Go (`opencode-go`) and Google Cloud Vertex AI Express Mode (`google-vertex`).
- **Context window**: Adjust `llm.contextWindowRatio` (`0.01`–`1.0`) to cap context window usage for automatic compaction. Optionally set `llm.compaction.backgroundTokens` to control how many tokens before the blocking threshold background compaction starts (Pi Durable default `32768`; `0` disables background compaction).
- **Image analysis**: Configure `llm.image` to use a separate one-shot vision model; its analysis is passed to the main conversation context.

### Voice Chat & TTS

- **Voice chat**: Powered by a bundled local Silero VAD (ONNX Runtime Web WASM) and WebSocket ASR. See [`docs/voice-chat-asr-protocol.md`](docs/voice-chat-asr-protocol.md).
- **TTS**: Connects to an external Style-Bert-VITS2 (SBV2) server via `features.tts.serverUrl`. Provides the `discord_voice` tool and voice chat output. See [`docs/sbv2-tts-protocol.md`](docs/sbv2-tts-protocol.md).
- **Voice reactions**: Set `features.voiceChat.reactions` to trigger short audio acknowledgments while generating full answers. Generate audio files from a manifest with:
  ```sh
  bun scripts/generate-voice-presets.ts [manifest-path]
  ```

### Memory

When `features.memory.enabled` is true, Klein periodically extracts durable guild facts and notes from recent conversations into `.runtime/memory/{guildId}/MEMORY.json` using an optional background model.

### Reminders

Reminders belong to a Discord channel (or thread) and its access scope: `public` or
`owner:<userId>`. They remain available to list and delete after conversation sessions
rotate. Notifications enter the current conversation session, and delivery checks the
current channel access rules and owner ID. Reminders whose scope is no longer allowed
remain stored without being delivered.

Reminder files under `<runtime.agentDir>/reminders` use this ownership model.
Legacy records containing `sessionKey` or `ownerFeaturesAllowed` are rejected;
the application does not migrate them at startup.

### Remote MCP Tools

Register MCP tools directly into Pi's agent directory (`.runtime/pi`):

```sh
PI_CODING_AGENT_DIR=.runtime/pi bunx pi mcp add docs --url https://mcp.example.com/mcp --exposure deferred
```

When a server answers 401, sign in from the command line (after `bun run build:server`):

```sh
bun dist/klein mcp login docs
```

The command serves the OAuth callback on `127.0.0.1` and prints the authorization URL. If the
browser runs on another machine, paste the URL it was redirected to instead. Credentials are
stored in `<runtime.agentDir>/mcp-auth.json`; set `oauth.callbackPort` or `oauth.callbackUrl`
in `mcp.json` when the OAuth client is registered with a fixed redirect URI.

Restart Klein after modifying MCP configurations.

### Owner Access

Locations and tools can be restricted using `owner` alongside `allow` and `deny`.
An `owner` location accepts interactions only from the bot owner, uses an isolated session history, and does not record conversations into shared guild memory.
Tools and MCP servers requiring `owner` access only run within those owner conversations.

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

## Agent Input Events

`AgentRuntime.prompt` and `steer` accept `AgentEvent` inputs defined in
`src/agents/core/agent-event.ts`. Each producer provides an internal tracing `id`,
an ISO 8601 `occurredAt` with a timezone, an event `type` (such as `discord.message`),
a `source`, and `content` containing text and image blocks:

```ts
await runtime.prompt({
  id: "reminder-123",
  occurredAt: "2026-10-14T18:30:42+09:00",
  type: "reminder.due",
  source: "reminder",
  content: [{ type: "text", text: "定例会の時間です。" }],
});
```

Text blocks use `{ type: "text", text }`; image blocks use
`{ type: "image", data, mimeType }`, where `data` is Base64. Source-specific data
stays in its producer; information relevant to the agent belongs in text blocks.
Pi receives the event type, source, and occurrence time in Japan Standard Time
at minute precision (for example, `2026-10-14 18:30 JST`), followed by the text
and images. The event ID and full timestamp stay internal. Discord preserves its
original posting time, author and reply text, conversation guidance, memory,
and channel rules. Voice transcripts use their receipt time.

New producers can use the same runtime interface for reminders, MCP notifications,
and messages from other agents. Discord Pi sessions provide deferred
`reminder_add`, `reminder_list`, and `reminder_delete` tools. Reminders can run
once after a duration (minimum one minute), once at the next occurrence of a
time or at a specific date and time, or repeatedly at a JST time every day or
on selected weekdays. They are stored
under the Pi agent directory and delivered to the session that created them;
overdue repeating reminders fire once after a restart and then resume their
schedule. MCP notification subscriptions are not implemented yet. Tool
permissions are fixed when the agent is created and apply to every event it
processes, including reminders and MCP notifications.
`prompt(event)` and `steer(event)` need no per-input permission options.
Owner-only tools require an owner-enabled session established by trusted
application access checks; event content cannot grant owner access.
