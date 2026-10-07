# Voice chat ASR streaming protocol

## Klein setup

Set `features.voiceChat.enabled` to `true` and point `asrServerUrl` to the
server's WebSocket base URL. `language` defaults to `ja`. In Discord, run
`/voice join` from a text channel while connected to a voice channel; Klein
captures only the command user's speech and posts final transcripts back to the
text channel. Run `/voice leave` to stop.

This first pass handles one active speaker per server and uses 900 ms of silence
to end an utterance. Partial transcripts are available to the application but
are not posted to Discord.

Klein connects to an ASR server over WebSocket. The server owns model loading and
GPU inference. The protocol does not expose model-specific settings.

## Connection

Connect to `/v1/stream` using `ws://` on a trusted private network or `wss://`
when TLS is available. Each connection represents one Discord voice-chat
session and one recognized speaker.

The client starts a session with a JSON text frame:

```json
{
  "type": "session.start",
  "language": "ja",
  "audio": {
    "encoding": "pcm_s16le",
    "sampleRateHz": 16000,
    "channels": 1
  }
}
```

The server replies with `{"type":"session.ready"}` after it is ready to accept
audio.

The server may reject an unsupported language or audio format with an `error`
message, then close the connection. Control frames are UTF-8 JSON objects and
must not contain fields beyond those shown here.

## Audio and utterances

The client marks the start of an utterance with a JSON text frame:

```json
{ "type": "utterance.start", "utteranceId": "unique-id" }
```

It then sends ordered binary WebSocket frames containing signed 16-bit little
endian, 16 kHz, mono PCM samples. A frame can contain any positive number of
whole samples. The client ends the utterance with:

```json
{ "type": "utterance.end", "utteranceId": "unique-id" }
```

The connection stays open for later utterances. Audio for different utterances
must not overlap on one connection.

Each utterance has exactly one start and one end frame. The client sends audio
only between those frames and waits for the final transcript before starting
the next utterance on the same connection.

## Transcript events

The server may send zero or more partial results while an utterance is active.
Each partial replaces the previous partial for that utterance:

```json
{ "type": "transcript.partial", "utteranceId": "unique-id", "text": "こんにちは" }
```

After the client ends an utterance, the server sends its final transcript:

```json
{ "type": "transcript.final", "utteranceId": "unique-id", "text": "こんにちは。" }
```

The final result is immutable. An empty final transcript means the utterance
contained no recognized speech.

Errors use this shape and end the current session:

```json
{ "type": "error", "code": "unsupported_audio_format", "message": "..." }
```

The client closes the WebSocket when the Discord voice session ends.
