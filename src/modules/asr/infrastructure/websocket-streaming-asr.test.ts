import assert from "node:assert/strict";
import test from "node:test";

import { WebSocketStreamingAsr } from "./websocket-streaming-asr";

type Listener = (event: unknown) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static latest?: FakeWebSocket;

  bufferedAmount = 0;
  readyState = FakeWebSocket.CONNECTING;
  readonly sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  failNextSend = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: URL) {
    FakeWebSocket.latest = this;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("send failed");
    }
    this.sent.push(data);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", new Event("open"));
  }

  message(data: string): void {
    this.emit("message", { data });
  }

  serverClose(code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code });
  }

  markClosedWithoutEvent(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  emitClose(code = 1000): void {
    this.emit("close", { code });
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = FakeWebSocket.CLOSED;
    this.emitClose(code);
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

async function connectReady() {
  const connecting = new WebSocketStreamingAsr("ws://asr.example.test").connect({
    language: "ja",
    audio: { encoding: "pcm_s16le", sampleRateHz: 16_000, channels: 1 },
  });
  const socket = FakeWebSocket.latest;
  assert.ok(socket);
  socket.open();
  socket.message('{"type":"session.ready"}');
  return { session: await connecting, socket };
}

function useFakeWebSocket(): () => void {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  FakeWebSocket.latest = undefined;
  return () => {
    globalThis.WebSocket = original;
  };
}

test("starts an ASR session and delivers final transcript updates", async () => {
  const restore = useFakeWebSocket();
  try {
    const { session, socket } = await connectReady();
    const updates: unknown[] = [];
    session.onTranscript((update) => updates.push(update));

    assert.equal(socket.url.pathname, "/v1/stream");
    assert.deepEqual(JSON.parse(String(socket.sent[0])), {
      type: "session.start",
      language: "ja",
      audio: { encoding: "pcm_s16le", sampleRateHz: 16_000, channels: 1 },
    });
    socket.message('{"type":"transcript.final","utteranceId":"u1","text":"こんにちは"}');
    assert.deepEqual(updates, [{ utteranceId: "u1", text: "こんにちは", final: true }]);
    session.close();
  } finally {
    restore();
  }
});

test("reports an ASR server error and closes the socket", async () => {
  const restore = useFakeWebSocket();
  try {
    const { session, socket } = await connectReady();
    const errors: Error[] = [];
    session.onError((error) => errors.push(error));

    socket.message('{"type":"error","code":"unsupported_language","message":"no ja"}');

    assert.match(errors[0]?.message ?? "", /unsupported_language\): no ja/);
    assert.equal(socket.closeCalls.length, 1);
  } finally {
    restore();
  }
});

test("reports an unexpected server disconnect once", async () => {
  const restore = useFakeWebSocket();
  try {
    const { session, socket } = await connectReady();
    const errors: Error[] = [];
    session.onError((error) => errors.push(error));

    socket.serverClose(1006);

    assert.equal(errors.length, 1);
    assert.match(errors[0]?.message ?? "", /closed unexpectedly \(1006\)/);
  } finally {
    restore();
  }
});

test("does not report a close event that races with a client close", async () => {
  const restore = useFakeWebSocket();
  try {
    const { session, socket } = await connectReady();
    const errors: Error[] = [];
    session.onError((error) => errors.push(error));

    socket.markClosedWithoutEvent();
    session.close();
    socket.emitClose(1000);

    assert.equal(errors.length, 0);
  } finally {
    restore();
  }
});

test("rejects promptly when sending the initial session frame fails", async () => {
  const restore = useFakeWebSocket();
  try {
    const connecting = new WebSocketStreamingAsr("ws://asr.example.test").connect({
      language: "ja",
      audio: { encoding: "pcm_s16le", sampleRateHz: 16_000, channels: 1 },
    });
    const socket = FakeWebSocket.latest;
    assert.ok(socket);
    socket.failNextSend = true;
    socket.open();

    await assert.rejects(connecting, /send failed/);
    assert.equal(socket.closeCalls.length, 1);
  } finally {
    restore();
  }
});
