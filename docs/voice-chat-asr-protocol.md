# ASR WebSocket protocol

This document defines the WebSocket protocol between Klein and an ASR server.
The ASR server owns model loading and inference. Model and decoding settings
are outside this protocol.

## Connection

Connect to the server's `/v1/asr` endpoint using `ws://` on a trusted private
network or `wss://` when TLS is available. Klein uses the configured server
URL's scheme and host with the `/v1/asr` path. Each connection represents one
ASR session.

The server accepts a connection only when its ASR model is ready. There is no
session initialization or ready message. The client may send `asr.start` as
soon as the WebSocket opens. Control messages are UTF-8 JSON text frames. Audio
is sent in binary WebSocket frames.

## Audio format

Audio is signed 16-bit little-endian PCM, 16 kHz, mono. Each binary frame must
contain a positive number of complete PCM samples. Frames for a request are
sent in order.

## Requests

Start an utterance with a JSON text frame containing a non-empty `requestId`
and language string:

```json
{ "type": "asr.start", "requestId": "unique-id", "language": "ja" }
```

Send the request's binary audio frames, then commit it with:

```json
{ "type": "asr.commit", "requestId": "unique-id" }
```

Only one request may be uploading at a time on a connection. After committing
it, the client may start uploading the next request while inference for earlier
requests is still pending. The server may return results out of order; match
each response to its request by `requestId`. A request ID must be unique among
pending requests. Avoid reusing IDs on a connection so a late response cannot
be mistaken for a newer request.

An upload may contain at most 30 seconds of PCM. The client permits at most
eight pending requests per connection and waits up to 120 seconds for a result
after commit. The server should return exactly one terminal response for each
committed request.

## Results and errors

A successful request returns one completed message. An empty `text` means no
speech was recognized:

```json
{ "type": "asr.completed", "requestId": "unique-id", "text": "こんにちは。" }
```

A request-level failure rejects only that request; the connection remains
open:

```json
{
  "type": "asr.failed",
  "requestId": "unique-id",
  "code": "audio_too_long",
  "message": "..."
}
```

All control messages must contain only the fields shown for their message
type. `requestId` and `code` must be non-empty strings; `text` may be empty.
Malformed or unsupported server messages, a response for a request that has
not been committed, or an unexpected connection close fail all pending
requests. Responses for IDs that are no longer pending, such as late results
after a timeout, are ignored. Klein closes the WebSocket when the ASR session
ends.
