# SBV2 HTTP protocol

This document defines the HTTP protocol between Klein and an SBV2 text-to-speech
server. The server owns model loading, voice selection, and synthesis settings;
these are outside this protocol.

## Request

Configure Klein with the server's base URL, for example
`http://100.64.0.10:5000`. Klein sends one HTTP `GET` request for each synthesis
to the `/voice` endpoint. The text to synthesize is the `text` query parameter,
encoded as UTF-8 using URL query encoding:

```http
GET /voice?text=こんにちは HTTP/1.1
Host: 100.64.0.10:5000
```

The example shows the decoded parameter value; on the wire, non-ASCII text is
percent-encoded. The URL path is `/voice` at the server root. Klein does not
send a request body, authentication headers, or synthesis options. Each request
is independent; there is no session or request identifier.

## Response

Any successful HTTP status (2xx) is treated as a successful synthesis. The
response body must contain the synthesized audio as WAV bytes, which Klein
passes to its caller for use as a WAV attachment or voice playback. Klein does
not inspect the response content type or validate the WAV data.

For a non-successful HTTP status, Klein raises an error containing the status
code and response body text. There is no protocol-level error object or retry
behavior.

## Limits and lifecycle

Klein does not impose a text length limit, synthesis timeout, or concurrency
limit at this protocol layer. HTTP connection management is handled by the
runtime's `fetch` implementation. Configure the base URL with `http://` on a
trusted private network or `https://` when TLS is available.
