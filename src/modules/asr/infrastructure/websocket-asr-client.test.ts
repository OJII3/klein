import assert from "node:assert/strict";
import test from "node:test";

import { WebSocketAsrClient } from "./websocket-asr-client";

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
  private readonly listeners = new Map<string, Listener[]>();
  constructor(readonly url: URL) {
    FakeWebSocket.latest = this;
  }
  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
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
  close(code = 1000): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code });
  }
  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

async function connectReady() {
  const connecting = new WebSocketAsrClient("ws://asr.example.test").connect();
  const socket = FakeWebSocket.latest;
  assert.ok(socket);
  socket.open();
  return { connection: await connecting, socket };
}

function useFakeWebSocket(): () => void {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  FakeWebSocket.latest = undefined;
  return () => {
    globalThis.WebSocket = original;
  };
}

test("streams PCM to /v1/asr and resolves a committed request", async () => {
  const restore = useFakeWebSocket();
  try {
    const { connection, socket } = await connectReady();
    const request = connection.start({ requestId: "r1", language: "ja" });
    request.write(new Uint8Array([1, 0]));
    const result = request.commit();
    assert.equal(socket.url.pathname, "/v1/asr");
    assert.deepEqual(JSON.parse(String(socket.sent[0])), {
      type: "asr.start",
      requestId: "r1",
      language: "ja",
    });
    assert.deepEqual([...new Uint8Array(socket.sent[1] as ArrayBuffer)], [1, 0]);
    assert.deepEqual(JSON.parse(String(socket.sent[2])), { type: "asr.commit", requestId: "r1" });
    socket.message('{"type":"asr.completed","requestId":"r1","text":"こんにちは"}');
    assert.deepEqual(await result, { text: "こんにちは" });
    connection.close();
  } finally {
    restore();
  }
});

test("allows a later upload while earlier inference is pending and isolates request errors", async () => {
  const restore = useFakeWebSocket();
  try {
    const { connection, socket } = await connectReady();
    const first = connection.start({ requestId: "r1", language: "ja" });
    first.write(new Uint8Array([0, 0]));
    const firstResult = first.commit();
    const second = connection.start({ requestId: "r2", language: "ja" });
    second.write(new Uint8Array([0, 0]));
    const secondResult = second.commit();
    socket.message('{"type":"asr.failed","requestId":"r1","code":"bad_audio","message":"invalid"}');
    await assert.rejects(firstResult, /bad_audio/);
    socket.message('{"type":"asr.completed","requestId":"r2","text":"次"}');
    assert.deepEqual(await secondResult, { text: "次" });
    connection.close();
  } finally {
    restore();
  }
});

test("rejects pending requests when the socket disconnects", async () => {
  const restore = useFakeWebSocket();
  try {
    const { connection, socket } = await connectReady();
    const request = connection.start({ requestId: "r1", language: "ja" });
    const result = request.commit();
    socket.serverClose();
    await assert.rejects(result, /closed unexpectedly/);
  } finally {
    restore();
  }
});
