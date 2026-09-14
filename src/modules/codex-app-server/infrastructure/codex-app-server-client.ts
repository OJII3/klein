import { createHash, randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";

import type { InitializeParams } from "../protocol/generated/InitializeParams.js";
import type { InitializeResponse } from "../protocol/generated/InitializeResponse.js";
import type { ThreadStartParams } from "../protocol/generated/v2/ThreadStartParams.js";
import type { TurnStartParams } from "../protocol/generated/v2/TurnStartParams.js";

type RpcId = number | string;

interface RpcRequest {
  readonly id: RpcId;
  readonly method: string;
  readonly params?: unknown;
}

interface RpcResponse {
  readonly id: RpcId;
  readonly result?: unknown;
  readonly error?: {
    readonly code?: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

interface RpcServerRequest extends RpcRequest {
  readonly method: string;
}

interface RpcNotification {
  readonly method: string;
  readonly params?: unknown;
}

type RpcMessage = RpcResponse | RpcServerRequest | RpcNotification;

export interface CodexAppServerTransport {
  connect(onData: (data: string) => void, onClose: (error: Error) => void): Promise<void>;
  send(data: string): void;
  close(): void;
}

export interface CodexAppServerUnixTransportOptions {
  readonly socketPath: string;
}

/**
 * The app server's Unix transport is a WebSocket over a Unix domain socket.
 * Node's WebSocket client does not support UDS, so Klein performs the small
 * RFC 6455 handshake and frame exchange here.
 */
export class CodexAppServerUnixTransport implements CodexAppServerTransport {
  private socket?: Socket;
  private onData?: (data: string) => void;
  private onClose?: (error: Error) => void;
  private receiveBuffer = Buffer.alloc(0);
  private expectedAccept?: string;
  private handshakeComplete = false;
  private closed = false;
  private fragments: Buffer[] = [];
  private handshakeResolve?: () => void;
  private handshakeReject?: (error: Error) => void;

  constructor(private readonly options: CodexAppServerUnixTransportOptions) {}

  async connect(onData: (data: string) => void, onClose: (error: Error) => void): Promise<void> {
    if (this.socket) throw new Error("Codex app-server transport cannot be reused");
    this.onData = onData;
    this.onClose = onClose;

    const key = randomBytes(16).toString("base64");
    this.expectedAccept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");

    const socket = createConnection({ path: this.options.socketPath });
    this.socket = socket;
    socket.on("connect", () => {
      socket.write(
        [
          "GET / HTTP/1.1",
          "Host: localhost",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", (data) => this.handleData(Buffer.from(data)));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("Codex app-server socket closed")));

    await new Promise<void>((resolve, reject) => {
      this.handshakeResolve = resolve;
      this.handshakeReject = reject;
    });
  }

  send(data: string): void {
    if (!this.socket?.writable || !this.handshakeComplete) {
      throw new Error("Codex app-server WebSocket is not writable");
    }

    this.writeFrame(0x1, Buffer.from(data));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handshakeReject?.(new Error("Codex app-server WebSocket closed"));
    this.handshakeReject = undefined;
    this.handshakeResolve = undefined;
    this.socket?.destroy();
    this.socket = undefined;
  }

  private handleData(data: Buffer): void {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);
    if (!this.handshakeComplete) {
      const headerEnd = this.receiveBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (this.receiveBuffer.length > 64 * 1024) {
          this.fail(new Error("Codex app-server WebSocket handshake was too large"));
        }
        return;
      }

      const headers = this.receiveBuffer.subarray(0, headerEnd).toString("latin1");
      this.receiveBuffer = this.receiveBuffer.subarray(headerEnd + 4);
      try {
        this.validateHandshake(headers);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.handshakeComplete = true;
      this.handshakeResolve?.();
      this.handshakeResolve = undefined;
      this.handshakeReject = undefined;
    }

    this.readFrames();
  }

  private validateHandshake(headers: string): void {
    const [statusLine, ...headerLines] = headers.split("\r\n");
    if (!/^HTTP\/1\.1 101(?: |$)/.test(statusLine ?? "")) {
      throw new Error(`Codex app-server WebSocket handshake failed: ${statusLine ?? "no status"}`);
    }

    const values = new Map<string, string>();
    for (const line of headerLines) {
      const separator = line.indexOf(":");
      if (separator < 0) continue;
      values.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }

    if (values.get("upgrade")?.toLowerCase() !== "websocket") {
      throw new Error("Codex app-server WebSocket handshake did not upgrade the connection");
    }
    if (values.get("sec-websocket-accept") !== this.expectedAccept) {
      throw new Error("Codex app-server WebSocket handshake returned an invalid accept key");
    }
  }

  private readFrames(): void {
    while (this.receiveBuffer.length >= 2) {
      const first = this.receiveBuffer[0];
      const second = this.receiveBuffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let payloadLength = second & 0x7f;
      let headerLength = 2;

      if ((first & 0x70) !== 0) {
        this.fail(new Error("Codex app-server WebSocket frame used a reserved bit"));
        return;
      }
      if (payloadLength === 126) {
        if (this.receiveBuffer.length < 4) return;
        payloadLength = this.receiveBuffer.readUInt16BE(2);
        headerLength = 4;
      } else if (payloadLength === 127) {
        if (this.receiveBuffer.length < 10) return;
        if (this.receiveBuffer.readUInt32BE(2) !== 0) {
          this.fail(new Error("Codex app-server WebSocket frame is too large"));
          return;
        }
        payloadLength = this.receiveBuffer.readUInt32BE(6);
        headerLength = 10;
      }

      const maskLength = masked ? 4 : 0;
      const frameLength = headerLength + maskLength + payloadLength;
      if (this.receiveBuffer.length < frameLength) return;

      let payload = this.receiveBuffer.subarray(headerLength + maskLength, frameLength);
      if (masked) {
        const mask = this.receiveBuffer.subarray(headerLength, headerLength + 4);
        payload = Buffer.from(payload);
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }
      this.receiveBuffer = this.receiveBuffer.subarray(frameLength);
      this.handleFrame(opcode, fin, payload);
      if (this.closed) return;
    }
  }

  private handleFrame(opcode: number, fin: boolean, payload: Buffer): void {
    if (opcode === 0x8) {
      this.fail(new Error("Codex app-server WebSocket closed the connection"));
      return;
    }
    if (opcode === 0x9) {
      this.writeFrame(0xa, payload);
      return;
    }
    if (opcode === 0xa) return;

    if (opcode === 0x1 && this.fragments.length === 0) {
      this.fragments = [payload];
    } else if (opcode === 0x0 && this.fragments.length > 0) {
      this.fragments.push(payload);
    } else {
      this.fail(new Error("Codex app-server sent an invalid WebSocket fragment"));
      return;
    }

    if (!fin) return;
    this.onData?.(Buffer.concat(this.fragments).toString("utf8"));
    this.fragments = [];
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (!this.socket?.writable) return;
    const mask = randomBytes(4);
    const maskedPayload = Buffer.from(payload);
    for (let index = 0; index < maskedPayload.length; index += 1) {
      maskedPayload[index] ^= mask[index % 4];
    }

    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(payload.length, 6);
    }
    this.socket.write(Buffer.concat([header, mask, maskedPayload]));
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.handshakeReject?.(error);
    this.handshakeReject = undefined;
    this.handshakeResolve = undefined;
    this.onClose?.(error);
    this.socket?.destroy();
    this.socket = undefined;
  }
}

export interface CodexAppServerClientOptions extends CodexAppServerUnixTransportOptions {
  readonly cwd: string;
  readonly model?: string;
  readonly timeoutMs?: number;
}

export interface CodexAppServerRunResult {
  readonly threadId: string;
  readonly turnId: string;
  readonly status: "completed";
  readonly summary: string;
}

export class CodexAppServerRpcError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "CodexAppServerRpcError";
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Codex app-server response did not contain a valid ${field}`);
  }

  return value;
}

function readThreadId(value: unknown): string {
  const thread = isRecord(value) ? value.thread : undefined;
  return readString(isRecord(thread) ? thread.id : undefined, "thread id");
}

function readTurnId(value: unknown): string {
  const turn = isRecord(value) ? value.turn : undefined;
  return readString(isRecord(turn) ? turn.id : undefined, "turn id");
}

function readTurnStatus(value: unknown): string {
  const turn = isRecord(value) ? value.turn : undefined;
  return readString(isRecord(turn) ? turn.status : undefined, "turn status");
}

function readTurnError(value: unknown): string | undefined {
  const turn = isRecord(value) ? value.turn : undefined;
  const error = isRecord(turn) ? turn.error : undefined;
  if (!error) return undefined;
  return typeof error === "string" ? error : JSON.stringify(error);
}

function readAgentMessageText(value: unknown): string {
  const turn = isRecord(value) ? value.turn : undefined;
  const items = isRecord(turn) && Array.isArray(turn.items) ? turn.items : [];
  return items
    .filter(
      (item): item is Record<string, unknown> =>
        isRecord(item) && item.type === "agentMessage" && typeof item.text === "string",
    )
    .map((item) => item.text as string)
    .join("\n\n")
    .trim();
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class CodexAppServerClient {
  private readonly transport: CodexAppServerTransport;
  private readonly pending = new Map<
    RpcId,
    {
      readonly method: string;
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
    }
  >();
  private nextRequestId = 1;
  private lineBuffer = "";
  private completion?: { readonly threadId: string; readonly deferred: Deferred<unknown> };
  private agentMessageText = "";
  private connected = false;
  private runStarted = false;
  private failure?: Error;

  constructor(
    private readonly options: CodexAppServerClientOptions,
    transport: CodexAppServerTransport = new CodexAppServerUnixTransport(options),
  ) {
    this.transport = transport;
  }

  async run(task: string, signal?: AbortSignal): Promise<CodexAppServerRunResult> {
    if (this.runStarted) throw new Error("Codex app-server client cannot be reused");
    this.runStarted = true;

    const timeoutMs = this.options.timeoutMs ?? 15 * 60 * 1_000;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abort = (): void => {
      this.fail(new Error("Codex app-server delegation was cancelled"));
    };

    try {
      if (signal?.aborted) throw new Error("Codex app-server delegation was cancelled");
      signal?.addEventListener("abort", abort, { once: true });
      timeout = setTimeout(
        () => this.fail(new Error(`Codex app-server delegation timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );

      await this.connect();
      const initializeParams: InitializeParams = {
        clientInfo: {
          name: "klein",
          title: "Klein Codex delegate",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
        },
      };
      await this.request<InitializeResponse>("initialize", initializeParams);
      this.notify("initialized");

      const threadStartParams: ThreadStartParams = {
        cwd: this.options.cwd,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        ephemeral: true,
        sessionStartSource: "startup",
        threadSource: "klein",
        ...(this.options.model ? { model: this.options.model } : {}),
      };
      const threadResponse = await this.request<unknown>("thread/start", threadStartParams);
      const threadId = readThreadId(threadResponse);

      const completion = createDeferred<unknown>();
      this.completion = { threadId, deferred: completion };
      const turnStartParams: TurnStartParams = {
        threadId,
        input: [
          {
            type: "text",
            text: task,
            text_elements: [],
          },
        ],
      };
      const turnResponse = await this.request<unknown>("turn/start", turnStartParams);
      const turnId = readTurnId(turnResponse);
      const completed = await completion.promise;
      const status = readTurnStatus(completed);
      if (status !== "completed") {
        const detail = readTurnError(completed);
        throw new Error(`Codex turn ${status}${detail ? `: ${detail}` : ""}`);
      }

      const summary =
        this.agentMessageText.trim() ||
        readAgentMessageText(completed) ||
        "Codex completed the delegated task.";
      return { threadId, turnId, status: "completed", summary };
    } finally {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      this.completion = undefined;
      this.close();
    }
  }

  private async connect(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.connected) return;
    await this.transport.connect(
      (data) => this.handleData(data),
      (error) => this.fail(error),
    );
    if (this.failure) throw this.failure;
    this.connected = true;
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    if (this.failure) throw this.failure;
    const id = this.nextRequestId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
    });

    try {
      this.send({ id, method, params });
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }

    return promise as Promise<T>;
  }

  private notify(method: string): void {
    this.send({ method });
  }

  private send(message: Record<string, unknown>): void {
    this.transport.send(`${JSON.stringify(message)}\n`);
  }

  private handleData(data: string): void {
    this.lineBuffer += data;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.lineBuffer.slice(0, newlineIndex).trim();
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      if (line) {
        try {
          this.handleMessage(JSON.parse(line) as RpcMessage);
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  private handleMessage(message: RpcMessage): void {
    if (!isRecord(message)) throw new Error("Codex app-server returned a non-object message");

    if (typeof message.method === "string") {
      if ("id" in message) {
        this.handleServerRequest(message as unknown as RpcServerRequest);
      } else {
        this.handleNotification(message as unknown as RpcNotification);
      }
      return;
    }

    if (!("id" in message))
      throw new Error("Codex app-server returned a message without a method or id");
    const response = message as unknown as RpcResponse;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);

    if (response.error) {
      pending.reject(
        new CodexAppServerRpcError(
          response.error.message,
          pending.method,
          response.error.code,
          response.error.data,
        ),
      );
      return;
    }

    pending.resolve(response.result);
  }

  private handleNotification(notification: RpcNotification): void {
    const params = notification.params;
    if (!isRecord(params) || params.threadId !== this.completion?.threadId) return;
    if (notification.method === "item/agentMessage/delta") {
      if (typeof params.delta === "string") this.agentMessageText += params.delta;
      return;
    }
    if (notification.method === "turn/completed") this.completion?.deferred.resolve(params);
  }

  private handleServerRequest(request: RpcServerRequest): void {
    const result = this.serverRequestResponse(request.method);
    if (result) {
      this.send({ id: request.id, result });
      return;
    }

    this.send({
      id: request.id,
      error: {
        code: -32601,
        message: `Klein does not handle the Codex server request ${request.method}`,
      },
    });
  }

  private serverRequestResponse(method: string): Record<string, unknown> | undefined {
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "applyPatchApproval":
      case "execCommandApproval":
        return { decision: "decline" };
      case "item/permissions/requestApproval":
        return { permissions: {}, scope: "turn" };
      case "item/tool/requestUserInput":
        return { answers: {} };
      case "mcpServer/elicitation/request":
        return { action: "decline", content: null, _meta: null };
      default:
        return undefined;
    }
  }

  private fail(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(formatValue(error));
    this.failure ??= normalized;
    for (const pending of this.pending.values()) pending.reject(normalized);
    this.pending.clear();
    this.completion?.deferred.reject(normalized);
    this.transport.close();
  }

  private close(): void {
    this.connected = false;
    this.fail(new Error("Codex app-server connection closed"));
    this.transport.close();
  }
}
