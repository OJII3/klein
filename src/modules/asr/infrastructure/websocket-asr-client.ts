import { Check } from "typebox/value";

import type { AsrClient, AsrConnection, AsrRequest } from "../domain/asr-client";
import {
  AsrClientMessageSchema,
  AsrServerMessageSchema,
  type AsrClientMessage,
  type AsrServerMessage,
} from "./websocket-asr-protocol";

const CONNECT_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_BUFFERED_AUDIO_BYTES = 1_048_576;
const MAX_REQUEST_AUDIO_BYTES = 30 * 16_000 * 2;
const MAX_PENDING_REQUESTS = 8;

interface PendingRequest {
  resolve?: (result: { readonly text: string }) => void;
  reject?: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  bytes: number;
  committed: boolean;
}

export class WebSocketAsrClient implements AsrClient {
  constructor(private readonly serverUrl: string) {}

  async connect(): Promise<AsrConnection> {
    const url = new URL("/v1/asr", this.serverUrl);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new Error("ASR server URL must use ws:// or wss://");
    }
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out connecting to ASR server")),
        CONNECT_TIMEOUT_MS,
      );
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error("ASR WebSocket connection failed"));
        },
        { once: true },
      );
      socket.addEventListener(
        "close",
        () => {
          clearTimeout(timeout);
          reject(new Error("ASR WebSocket closed before connecting"));
        },
        { once: true },
      );
    }).catch((error: unknown) => {
      socket.close();
      throw error;
    });

    const requests = new Map<string, PendingRequest>();
    const errorHandlers = new Set<(error: Error) => void>();
    let uploadingRequestId: string | undefined;
    let closedByClient = false;
    let failed = false;

    const rejectRequest = (requestId: string, error: Error): void => {
      const request = requests.get(requestId);
      if (!request) return;
      if (request.timer) clearTimeout(request.timer);
      requests.delete(requestId);
      if (uploadingRequestId === requestId) uploadingRequestId = undefined;
      request.reject?.(error);
    };

    socket.addEventListener("message", (event) => {
      let message: unknown;
      try {
        if (typeof event.data !== "string") throw new Error("non-text control frame");
        message = JSON.parse(event.data);
      } catch (error) {
        failConnection(new Error("ASR server sent an invalid protocol message", { cause: error }));
        socket.close(1002, "Invalid protocol message");
        return;
      }
      if (!Check(AsrServerMessageSchema, message)) {
        failConnection(new Error("ASR server sent an unsupported protocol message"));
        socket.close(1002, "Unsupported protocol message");
        return;
      }
      const response = message as AsrServerMessage;
      const request = requests.get(response.requestId);
      if (!request) return;
      if (!request.committed) {
        failConnection(
          new Error(`ASR server replied to an unknown request (${response.requestId})`),
        );
        socket.close(1002, "Unknown request");
        return;
      }
      if (response.type === "asr.completed") {
        if (request.timer) clearTimeout(request.timer);
        requests.delete(response.requestId);
        request.resolve?.({ text: response.text });
      } else {
        rejectRequest(
          response.requestId,
          new Error(`ASR request failed (${response.code}): ${response.message}`),
        );
      }
    });
    socket.addEventListener("error", () =>
      failConnection(new Error("ASR WebSocket connection failed")),
    );
    socket.addEventListener("close", (event) => {
      if (!closedByClient)
        failConnection(new Error(`ASR WebSocket closed unexpectedly (${event.code})`));
    });

    function failConnection(error: Error): void {
      if (failed || closedByClient) return;
      failed = true;
      for (const requestId of requests.keys()) rejectRequest(requestId, error);
      for (const handler of errorHandlers) handler(error);
    }

    return {
      onError(handler) {
        errorHandlers.add(handler);
        return () => errorHandlers.delete(handler);
      },
      start({ requestId, language }): AsrRequest {
        if (failed || socket.readyState !== WebSocket.OPEN)
          throw new Error("ASR connection is not available");
        if (uploadingRequestId) throw new Error("An ASR request is already uploading");
        if (requests.has(requestId)) throw new Error(`Duplicate ASR request ID (${requestId})`);
        if (requests.size >= MAX_PENDING_REQUESTS)
          throw new Error("ASR pending request limit exceeded");
        sendControl(socket, { type: "asr.start", requestId, language });
        const state: PendingRequest = { bytes: 0, committed: false };
        requests.set(requestId, state);
        uploadingRequestId = requestId;
        let commitPromise: Promise<{ readonly text: string }> | undefined;
        return {
          write(pcm) {
            if (failed || socket.readyState !== WebSocket.OPEN)
              throw new Error("ASR connection is not available");
            if (uploadingRequestId !== requestId || state.committed)
              throw new Error("ASR request is not uploading");
            if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0)
              throw new Error("ASR audio frames must contain whole PCM samples");
            if (state.bytes + pcm.byteLength > MAX_REQUEST_AUDIO_BYTES) {
              throw new Error("ASR request audio exceeded 30 seconds");
            }
            state.bytes += pcm.byteLength;
            if (socket.bufferedAmount > MAX_BUFFERED_AUDIO_BYTES)
              throw new Error("ASR audio send queue exceeded its limit");
            socket.send(new Uint8Array(pcm).buffer);
          },
          commit() {
            if (commitPromise) return commitPromise;
            if (failed || socket.readyState !== WebSocket.OPEN)
              return Promise.reject(new Error("ASR connection is not available"));
            if (uploadingRequestId !== requestId || state.committed)
              return Promise.reject(new Error("ASR request is not uploading"));
            state.committed = true;
            uploadingRequestId = undefined;
            commitPromise = new Promise((resolve, reject) => {
              state.resolve = resolve;
              state.reject = reject;
              state.timer = setTimeout(() => {
                rejectRequest(requestId, new Error("Timed out waiting for ASR result"));
              }, REQUEST_TIMEOUT_MS);
            });
            try {
              sendControl(socket, { type: "asr.commit", requestId });
            } catch (error) {
              const sendError = error instanceof Error ? error : new Error(String(error));
              failConnection(sendError);
              socket.close(1011, "Failed to commit ASR request");
            }
            return commitPromise;
          },
        };
      },
      close() {
        closedByClient = true;
        for (const requestId of requests.keys())
          rejectRequest(requestId, new Error("ASR connection closed"));
        errorHandlers.clear();
        if (socket.readyState < WebSocket.CLOSING) socket.close(1000, "ASR connection finished");
      },
    };
  }
}

function sendControl(socket: WebSocket, message: AsrClientMessage): void {
  if (socket.readyState !== WebSocket.OPEN) throw new Error("ASR connection is not connected");
  if (!Check(AsrClientMessageSchema, message))
    throw new Error("Invalid ASR client protocol message");
  socket.send(JSON.stringify(message));
}
