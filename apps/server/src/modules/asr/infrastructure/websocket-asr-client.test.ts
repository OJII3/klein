import assert from "node:assert/strict";
import test from "node:test";

import { parseJson } from "@shared/type-guards";
import { WebSocketAsrClient, type AsrWebSocket } from "./websocket-asr-client";

type Listener = (event: { code: number; data: unknown }) => void;

class FakeWebSocket implements AsrWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  bufferedAmount = 0;
  readyState = FakeWebSocket.CONNECTING;
  readonly sent: Array<string | ArrayBuffer> = [];
  failNextSend = false;
  private readonly listeners = new Map<string, Listener[]>();
  constructor(readonly url: URL) {}
  addEventListener(
    type: "open" | "error" | "close" | "message",
    listener: Listener,
    _options?: { once?: boolean },
  ): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  send(data: string | ArrayBuffer): void {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("send failed");
    }
    this.sent.push(data);
  }
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", { code: 0, data: undefined });
  }
  message(data: string): void {
    this.emit("message", { code: 0, data });
  }
  serverClose(code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code, data: undefined });
  }
  fail(): void {
    this.emit("error", { code: 0, data: undefined });
  }
  close(code = 1000): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code, data: undefined });
  }
  private emit(type: string, event: { code: number; data: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

async function connectReady() {
  let socket: FakeWebSocket | undefined;
  const connecting = new WebSocketAsrClient("ws://asr.example.test", (url) => {
    socket = new FakeWebSocket(url);
    return socket;
  }).connect();
  assert.ok(socket);
  socket.open();
  return { connection: await connecting, socket };
}

function parseSentJson(socket: FakeWebSocket, index: number): unknown {
  const payload = socket.sent[index];
  if (typeof payload !== "string") {
    assert.fail(`Expected string payload at index ${index}`);
  }
  return parseJson(payload);
}

function readSentBytes(socket: FakeWebSocket, index: number): number[] {
  const payload = socket.sent[index];
  if (!(payload instanceof ArrayBuffer)) {
    assert.fail(`Expected ArrayBuffer payload at index ${index}`);
  }
  return [...new Uint8Array(payload)];
}

test("streams PCM to /v1/asr and resolves a committed request", async () => {
  const { connection, socket } = await connectReady();
  const request = connection.start({ requestId: "r1", language: "ja" });
  request.write(new Uint8Array([1, 0]));
  const result = request.commit();
  assert.equal(socket.url.pathname, "/v1/asr");
  assert.deepEqual(parseSentJson(socket, 0), {
    type: "asr.start",
    requestId: "r1",
    language: "ja",
  });
  assert.deepEqual(readSentBytes(socket, 1), [1, 0]);
  assert.deepEqual(parseSentJson(socket, 2), { type: "asr.commit", requestId: "r1" });
  socket.message('{"type":"asr.completed","requestId":"r1","text":"こんにちは"}');
  assert.deepEqual(await result, { text: "こんにちは" });
  connection.close();
});

test("allows a later upload while earlier inference is pending and isolates request errors", async () => {
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
});

test("rejects pending requests when the socket disconnects", async () => {
  const { connection, socket } = await connectReady();
  const request = connection.start({ requestId: "r1", language: "ja" });
  const result = request.commit();
  socket.serverClose();
  await assert.rejects(result, /closed unexpectedly/);
});

test("rejects a second upload while one request is still uploading", async () => {
  const { connection } = await connectReady();
  connection.start({ requestId: "r1", language: "ja" });
  assert.throws(() => connection.start({ requestId: "r2", language: "ja" }), /already uploading/);
  connection.close();
});

test("keeps an oversized upload commit-able and accepts the next request", async () => {
  const { connection, socket } = await connectReady();
  const first = connection.start({ requestId: "r1", language: "ja" });
  first.write(new Uint8Array(30 * 16_000 * 2));
  assert.throws(() => first.write(new Uint8Array([0, 0])), /exceeded 30 seconds/);
  const firstResult = first.commit();
  const second = connection.start({ requestId: "r2", language: "ja" });
  const secondResult = second.commit();
  socket.message('{"type":"asr.completed","requestId":"r1","text":"first"}');
  socket.message('{"type":"asr.completed","requestId":"r2","text":"second"}');
  assert.deepEqual(await firstResult, { text: "first" });
  assert.deepEqual(await secondResult, { text: "second" });
  connection.close();
});

test("rejects every committed request when the connection closes", async () => {
  const { connection } = await connectReady();
  const first = connection.start({ requestId: "r1", language: "ja" }).commit();
  const second = connection.start({ requestId: "r2", language: "ja" }).commit();
  connection.close();
  await Promise.all([
    assert.rejects(first, /connection closed/),
    assert.rejects(second, /connection closed/),
  ]);
});

test("fails the connection on invalid JSON or unsupported response schema", async () => {
  for (const payload of ["{", '{"type":"asr.completed","requestId":"r1"}']) {
    const { connection, socket } = await connectReady();
    const errors: Error[] = [];
    connection.onError((error) => errors.push(error));
    const result = connection.start({ requestId: "r1", language: "ja" }).commit();
    socket.message(payload);
    await assert.rejects(result, /ASR server sent/);
    assert.equal(errors.length, 1);
    assert.equal(socket.readyState, FakeWebSocket.CLOSED);
  }
});

test("notifies idle disconnect once", async () => {
  const { connection, socket } = await connectReady();
  const errors: Error[] = [];
  connection.onError((error) => errors.push(error));
  socket.serverClose();
  socket.fail();
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? "", /closed unexpectedly/);
});

test("ignores results for IDs that are not pending without disturbing active requests", async () => {
  const { connection, socket } = await connectReady();
  const errors: Error[] = [];
  connection.onError((error) => errors.push(error));
  const first = connection.start({ requestId: "r1", language: "ja" });
  const firstResult = first.commit();
  const second = connection.start({ requestId: "r2", language: "ja" });
  socket.message('{"type":"asr.completed","requestId":"late","text":"ignored"}');
  socket.message('{"type":"asr.completed","requestId":"r1","text":"first"}');
  assert.deepEqual(await firstResult, { text: "first" });
  const secondResult = second.commit();
  socket.message('{"type":"asr.completed","requestId":"r1","text":"duplicate"}');
  socket.message('{"type":"asr.completed","requestId":"r2","text":"second"}');
  assert.deepEqual(await secondResult, { text: "second" });
  assert.deepEqual(errors, []);
  connection.close();
});

test("closes the connection if sending commit fails", async () => {
  const { connection, socket } = await connectReady();
  const errors: Error[] = [];
  connection.onError((error) => errors.push(error));
  const request = connection.start({ requestId: "r1", language: "ja" });
  socket.failNextSend = true;
  await assert.rejects(request.commit(), /send failed/);
  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
  assert.equal(errors.length, 1);
});
