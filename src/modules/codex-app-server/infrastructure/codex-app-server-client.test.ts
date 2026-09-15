import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CodexAppServerClient,
  CodexAppServerUnixTransport,
  type CodexAppServerTransport,
} from "./codex-app-server-client";

class FakeTransport implements CodexAppServerTransport {
  readonly sent: Array<Record<string, unknown>> = [];
  private onData?: (data: string) => void;
  private holdCompletion = false;

  constructor(options?: { holdCompletion?: boolean }) {
    this.holdCompletion = options?.holdCompletion ?? false;
  }

  async connect(onData: (data: string) => void): Promise<void> {
    this.onData = onData;
  }

  send(data: string): void {
    const message = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(message);

    if (message.method === "initialize") {
      this.emit({
        id: message.id,
        result: {
          userAgent: "fake-codex",
          codexHome: "/tmp/codex",
          platformFamily: "unix",
          platformOs: "linux",
        },
      });
      return;
    }

    if (message.method === "thread/start") {
      this.emit({ id: message.id, result: { thread: { id: "thread-1" } } });
      return;
    }

    if (message.method !== "turn/start") return;
    this.emit({ id: message.id, result: { turn: { id: "turn-1" } } });
    if (this.holdCompletion) return;

    this.emit({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: {},
    });
    this.emit({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", delta: "変更しました" },
    });
    this.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", text: "変更しました" }],
        },
      },
    });
  }

  close(): void {}

  private emit(message: Record<string, unknown>): void {
    const data = `${JSON.stringify(message)}\n`;
    const splitAt = Math.max(1, Math.floor(data.length / 2));
    this.onData?.(data.slice(0, splitAt));
    this.onData?.(data.slice(splitAt));
  }
}

const options = {
  cwd: "/workspace/klein",
  socketPath: "/tmp/codex.sock",
};

test("runs a typed Codex app-server turn and declines approvals", async () => {
  const transport = new FakeTransport();
  const client = new CodexAppServerClient(options, transport);

  const result = await client.run("実装してテストして", undefined);

  assert.deepEqual(result, {
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    summary: "変更しました",
  });
  assert.deepEqual(transport.sent, [
    {
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "klein",
          title: "Klein Codex delegate",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
        },
      },
    },
    { method: "initialized" },
    {
      id: 2,
      method: "thread/start",
      params: {
        cwd: "/workspace/klein",
        approvalPolicy: "never",
        sandbox: "workspace-write",
        ephemeral: true,
        sessionStartSource: "startup",
        threadSource: "klein",
      },
    },
    {
      id: 3,
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [
          {
            type: "text",
            text: "実装してテストして",
            text_elements: [],
          },
        ],
      },
    },
    { id: "approval-1", result: { decision: "decline" } },
  ]);
});

test("cancels an in-progress delegation", async () => {
  const transport = new FakeTransport({ holdCompletion: true });
  const client = new CodexAppServerClient(options, transport);
  const controller = new AbortController();
  const running = client.run("待機して", controller.signal);

  await new Promise<void>((resolve) => queueMicrotask(resolve));
  controller.abort();

  await assert.rejects(running, /delegation was cancelled/);
});

test("connects to the app server's Unix WebSocket transport", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-codex-transport-"));
  const socketPath = join(directory, "server.sock");
  let receivedResolve!: (value: string) => void;
  let receivedReject!: (error: Error) => void;
  const received = new Promise<string>((resolve, reject) => {
    receivedResolve = resolve;
    receivedReject = reject;
  });
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let upgraded = false;

    socket.on("error", (error) => receivedReject(error));
    socket.on("data", (data) => {
      try {
        buffer = Buffer.concat([buffer, Buffer.from(data)]);
        if (!upgraded) {
          const headerEnd = buffer.indexOf("\r\n\r\n");
          if (headerEnd < 0) return;
          const request = buffer.subarray(0, headerEnd).toString("latin1");
          const key = request.match(/Sec-WebSocket-Key: ([^\r\n]+)/)?.[1];
          if (!key) throw new Error("test client did not send a WebSocket key");
          const accept = createHash("sha1")
            .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest("base64");
          socket.write(
            [
              "HTTP/1.1 101 Switching Protocols",
              "Upgrade: websocket",
              "Connection: Upgrade",
              `Sec-WebSocket-Accept: ${accept}`,
              "",
              "",
            ].join("\r\n"),
          );
          buffer = buffer.subarray(headerEnd + 4);
          upgraded = true;
        }

        if (buffer.length < 2) return;
        const payloadLength = buffer[1] & 0x7f;
        if ((buffer[1] & 0x80) === 0 || payloadLength >= 126) {
          throw new Error("test client did not send a short masked frame");
        }
        if (buffer.length < 6 + payloadLength) return;
        const mask = buffer.subarray(2, 6);
        const payload = Buffer.from(buffer.subarray(6, 6 + payloadLength));
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
        receivedResolve(payload.toString("utf8"));
        const response = Buffer.from('{"method":"test"}\n');
        socket.write(Buffer.concat([Buffer.from([0x81, response.length]), response]));
        buffer = buffer.subarray(6 + payloadLength);
      } catch (error) {
        receivedReject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

  const transport = new CodexAppServerUnixTransport({ socketPath });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    let responseResolve!: (value: string) => void;
    let responseReject!: (error: Error) => void;
    const response = new Promise<string>((resolve, reject) => {
      responseResolve = resolve;
      responseReject = reject;
    });
    await transport.connect(responseResolve, responseReject);
    transport.send("hello\n");

    assert.equal(await received, "hello\n");
    assert.equal(await response, '{"method":"test"}\n');
  } finally {
    transport.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { force: true, recursive: true });
  }
});
