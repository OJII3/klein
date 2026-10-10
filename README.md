# Klein

Pi-based communication agent.

## Run the Discord bot

Enter the Nix development shell and install dependencies:

```sh
nix develop
bun install
```

The Web UI is bundled into `dist/web` and served as static files by Elysia.
`bun run start` builds both the frontend and server, then runs `dist/klein`.
Use `bun run build:web` or `bun run build:server` to build either separately.

Copy the configuration and environment templates, fill in the Discord access
rules and bot token, then start it. `OPENCODE_API_KEY` is required only when an
active model uses `opencode-go`:

```sh
cp config/config.example.json config/config.jsonc
cp .env.example .env
${EDITOR:-vi} .env
${EDITOR:-vi} config/config.jsonc
bun run start
```

The configuration's `profile` selects the character loaded by the agent. The
default profile is `klein`, whose system prompt and skills live under
`config/klein/`. Add another profile under `config/<profile>/` with its own
`SOUL.md` and optional `skills/` directory, then change `profile` in
`config/config.jsonc` to switch characters. When `profile` is omitted, `klein`
is used. Voice chat loads the same profile's `SOUL.voice.md` instead of `SOUL.md`.
Provide that file when enabling `features.voiceChat` for a custom profile.
Set `CONFIG_PATH` when a different configuration file is needed.

The `yachiyo` profile in `config/yachiyo/` is based on
[YacchoGPT's for GPTs prompts](https://github.com/tsukumijima/YacchoGPT)
(CC0-1.0). It keeps Yachiyo's personality and voice in `SOUL.md`, with research,
Discord participation, and story knowledge in separate skills.
Set `"profile": "yachiyo"` in `config/config.jsonc` to select it.

By default, Klein resumes the latest Pi session for each Discord channel. Use
`--new` to start fresh sessions for the next run, or `--resume` to make the
default behavior explicit:

```sh
bun run start -- --new
bun run start -- --resume
```

The application supports OpenCode Go through Pi's `opencode-go` provider and
Google Cloud Vertex AI through `google-vertex`. For Vertex AI, set
`GOOGLE_CLOUD_API_KEY` in `.env` using a Vertex AI Express Mode API key; no
project or location setting is needed. Set the selected provider on `llm` (and
on optional image or memory models). Pi's
runtime data is stored in the directory configured by `runtime.agentDir`
(`.runtime/pi` by default), including the per-channel session history and the
cached model catalog. Klein refreshes Pi's online model catalog when starting;
cached and built-in model definitions remain available when the catalog cannot
be reached.

The `llm.model` and optional `llm.thinkingLevel` settings are used by the main
Pi session. Set `llm.contextWindowRatio` between `0.01` and `1` to limit the
model's context window; for example, `0.5` uses half of the model's published
window. Pi's automatic compaction and Klein's background compaction both use
this reduced limit. The setting defaults to `1` when omitted. The optional
`llm.image` setting configures a separate, one-shot image analysis model. When
it is configured, image attachments are sent only to that model; its text
analysis is provided to the main session as context, which keeps the final
response in the main model's voice. The image model must support image input.

To use an Exa API key with `pi-web-access`, optionally set `EXA_API_KEY` in `.env`.

The Discord agent's personality and behavior are loaded from the selected
profile's `SOUL.md` (`config/klein/SOUL.md` by default).
Voice chat uses `SOUL.voice.md` (`config/klein/SOUL.voice.md` by default), with
instructions for `discord_speak`, responding without mentions, and brief spoken
replies to reduce TTS latency. Edit the two files independently for each mode.

To connect remote MCP tools to the Discord agent, register the server in the
Pi agent directory `.runtime/pi`, which matches Klein's `runtime.agentDir`.
Prefix Pi CLI commands with `PI_CODING_AGENT_DIR=.runtime/pi` so both use the
same MCP configuration:

```sh
PI_CODING_AGENT_DIR=.runtime/pi bunx pi mcp add docs --url https://mcp.example.com/mcp --exposure deferred --description 'Search product documentation'
PI_CODING_AGENT_DIR=.runtime/pi bunx pi mcp login docs
```

`mcp add` writes the server configuration to Pi's `mcp.json`. Use `mcp login`
when the server requires OAuth. MCP tools configured with `deferred` exposure
are loaded through Pi's `tool_search` when needed. Restart Klein after changing
the MCP configuration.

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

The optional Web UI shows persisted Pino logs, Pi session history, and
guild memory contents. The memory tab lists guilds with persisted memory and
shows each entry's kind, title, body, timestamps, and source message count.
Update the `runtime` and `features` sections in `config/config.jsonc` (other
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
        "model": "qwen3.8-flash",
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
    },
    "tts": {
      "enabled": false,
      "serverUrl": "http://100.64.0.10:5000"
    }
  }
}
```

Start Klein, then open `http://127.0.0.1:4310`. Keep the host bound
to loopback when exposing the viewer through a ZeroTrust tunnel. The UI is
disabled by default and allows deleting individual persisted memories.

Enable `features.tts` and set `serverUrl` to the SBV2 server address reachable
through your private network to add the `discord_voice` tool. It synthesizes
text through SBV2's `/voice` endpoint and sends the returned WAV as a Discord
attachment. Voice chat also requires TTS: it sends each final ASR transcript to
the LLM, then sends the LLM's response to SBV2 and plays the returned audio in
the voice channel.

Voice chat uses a bundled Silero VAD model locally in Klein, then sends each
detected utterance to the configured WebSocket ASR server. The model runs with
ONNX Runtime Web's WASM backend and needs no model download at startup. See
[`docs/voice-chat-asr-protocol.md`](docs/voice-chat-asr-protocol.md) for the ASR
request protocol.

Optional voice reactions can shorten the perceived wait while the full answer
is being prepared. Configure `features.voiceChat.reactions` with the pi
classifier provider and model, plus a preset manifest. For example,
`cloudflare-workers-ai` / `@cf/cloudflare/clef-flash` uses pi's classifier
support and the same pi runtime as the rest of Klein; no separate API client is
needed. Set `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` before enabling
reactions. Enable `features.tts` and point it to the SBV2 server before
generating audio. Define the reaction phrases and audio paths in the configured
JSON manifest (`config/voice-presets.example.json` in the example). Generate the audio
with `bun scripts/generate-voice-presets.ts`; the script sends each manifest
phrase to the configured SBV2 server and writes the result to its `audioFile`
path. To generate directly in a separate preset repository, pass its manifest
path as the first argument; this overrides the configured `presetsFile`.
Runtime decisions select a preset by ID, then play its saved audio.
The example saves WAV files under `.runtime/voice-presets/example/`, which is
excluded from Git. Relative `audioFile` paths are resolved from the manifest's
directory; absolute paths are also supported. `presetsFile` is relative to the
working directory unless it is absolute.

Personal manifests and WAV files can be managed together in a separate private
repository without a submodule. For example, store `klein/presets.json` and
`klein/audio/*.wav` with `audioFile` values such as `audio/thinking.wav`. Clone the
private repository separately, check out the tag or commit you want to use, then
symlink its entire preset directory into Klein (run these commands from Klein's
root):

```bash
gh repo clone OWNER/VOICE_PRESETS ../voice-presets
mkdir -p .runtime
ln -s ../../voice-presets/klein .runtime/voice-presets
```

If `.runtime/voice-presets` already exists as a copied directory, move it aside
before creating the symlink. Link the entire directory, not just the manifest,
so relative audio paths work. Editing or regenerating presets updates the
private repository directly; restart Klein after changing the presets.

Set `features.voiceChat.reactions.presetsFile` to
`.runtime/voice-presets/presets.json` in your local configuration. The classifier
receives each preset's Japanese `text` and `description` and returns its `id`;
audio filenames are not sent to the classifier. Public builds and tests do not
require access to the private repository.

Reactions are skipped while an audio file is unavailable.
Reactions are disabled when this setting is omitted. The reaction is selected
alongside the main LLM request, and the main answer still takes priority when
its audio is ready.

### HTTPS through Cloudflare Tunnel

Klein can start and stop `cloudflared` together with the Web UI. The Nix
development shell includes `cloudflared`; when running outside the shell,
install it separately and ensure it is on `PATH`, including for production bundles.

1. Create a remotely-managed Cloudflare Tunnel and obtain its tunnel token.
   This is the token for running that tunnel, rather than a Cloudflare API token.
2. Configure a published application route, for example
   `klein.example.com` to `http://127.0.0.1:4310`. Match the service address
   to your Web UI host and port.
3. Protect the hostname with Cloudflare Access and allow only your intended users.
   Without Access, the logs, session history, and memory deletion API are public.
4. Add `TUNNEL_TOKEN=...` to `.env`, enable the Web UI, and run `bun run start`.

Open `https://klein.example.com`. Cloudflare handles the browser-facing TLS
certificate; Klein continues serving HTTP on loopback. Tokens are passed to
`cloudflared` through its environment, and other application secrets are excluded.
See the [tunnel token documentation](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/)
and [Access setup guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/).

With no token, Klein starts only the local Web UI. With the Web UI disabled,
it does not start `cloudflared`. A missing `cloudflared` executable fails startup;
its process logs and unexpected exits appear in Klein's logs. The process-started
log does not indicate that the tunnel has connected. `cloudflared` handles network
reconnections; if its process exits, restart Klein after resolving the logged error.

To build ahead of time, run `bun run build` and then `bun dist/klein` from the
project root. Configuration and runtime data paths are resolved from the working
directory; the prebuilt server resolves `dist/web/` next to its executable.
Keep the installed dependencies available as well:
codemode loads its sandbox worker from `@earendil-works/pi-codemode` at runtime.
The frontend is not served with HMR:

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

The bot's Discord activity displays remaining monthly usage and refreshes hourly.
OpenCode Go includes its reset countdown. For Vertex AI, Klein estimates current
UTC calendar-month cost from token usage recorded in Pi sessions and the model
pricing known to Pi. The estimate is compared with a $10 budget and may be
negative after exceeding it. It does not include Vertex AI usage outside Klein,
and the final billed cost may differ.
