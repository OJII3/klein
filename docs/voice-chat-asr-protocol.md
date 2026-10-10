# Voice chat ASR protocol

## Klein setup

Set `features.voiceChat.enabled` to `true` and point `asrServerUrl` to the
server's WebSocket base URL. `language` defaults to `ja`. In Discord, run
`/voice join` while connected to a voice channel. Klein captures only the
command user's speech and sends final transcripts to a dedicated LLM
conversation session. Context continues between utterances until `/voice leave`.

Klein owns voice activity detection and utterance boundaries. The ASR server
owns model loading and inference. Its model and decoding settings are not part
of this protocol.

## Connection and audio

Connect to `/v1/asr` using `ws://` on a trusted private network or `wss://` when
TLS is available. Each connection represents one voice-chat session. Audio is
always signed 16-bit little-endian PCM, 16 kHz, mono; no format negotiation is
sent. Control frames are UTF-8 JSON objects. Audio frames are binary WebSocket
frames containing ordered PCM samples.

The server accepts connections only when its ASR model is ready. There is no
session initialization or ready message; the client may send `asr.start` as
soon as the WebSocket opens. The protocol has no partial transcript events.

For each utterance, send a start frame:

```json
{ "type": "asr.start", "requestId": "unique-id", "language": "ja" }
```

Send one or more binary PCM frames, then commit the request:

```json
{ "type": "asr.commit", "requestId": "unique-id" }
```

Only one request may be uploading at a time on a connection. After commit, its
inference can remain pending while the next request starts and uploads. The
server returns results by `requestId`; responses may arrive out of order. The
client preserves utterance order when passing transcripts to conversation
processing.

An upload may contain at most 30 seconds of PCM. The client limits queued
inference requests to eight and times out a result after 120 seconds. The
server should return one terminal response for each committed request. If a
timed-out result arrives late, the client ignores it. A timed-out `requestId`
cannot be reused on that connection.

## Results and errors

A successful request returns exactly one completed message. An empty `text`
means no speech was recognized:

```json
{ "type": "asr.completed", "requestId": "unique-id", "text": "こんにちは。" }
```

A request-level failure rejects only that request; the connection remains open:

```json
{
  "type": "asr.failed",
  "requestId": "unique-id",
  "code": "audio_too_long",
  "message": "..."
}
```

Malformed protocol messages or an unexpected connection close fail all pending
requests. Klein closes the WebSocket when the voice-chat session ends.
