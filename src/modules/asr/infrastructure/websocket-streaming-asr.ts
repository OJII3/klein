import { Check } from "typebox/value";

import type {
  AsrAudioFormat,
  AsrTranscriptUpdate,
  StreamingAsr,
  StreamingAsrSession,
} from "../domain/streaming-asr";
import {
  AsrClientMessageSchema,
  AsrServerMessageSchema,
  type AsrClientMessage,
  type AsrServerMessage,
} from "./websocket-streaming-asr-protocol";

const ASR_READY_TIMEOUT_MS = 15_000;
const MAX_BUFFERED_AUDIO_BYTES = 1_048_576;

export class WebSocketStreamingAsr implements StreamingAsr {
  constructor(private readonly serverUrl: string) {}

  async connect(options: {
    readonly language: string;
    readonly audio: AsrAudioFormat;
  }): Promise<StreamingAsrSession> {
    const url = new URL("/v1/stream", this.serverUrl);
    const socket = new WebSocket(url);
    const updates = new Set<(update: AsrTranscriptUpdate) => void>();
    const errors = new Set<(error: Error) => void>();
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    let ready = false;
    let sessionFailed = false;
    let closedByClient = false;
    const readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    socket.addEventListener("open", () => {
      sendControl(socket, {
        type: "session.start",
        language: options.language,
        audio: options.audio,
      });
    });
    socket.addEventListener("message", (event) => {
      let message: unknown;
      try {
        if (typeof event.data !== "string") {
          throw new Error("ASR server sent a non-text control message");
        }
        message = JSON.parse(event.data);
      } catch (error) {
        const parseError = new Error("ASR server sent an invalid protocol message", {
          cause: error,
        });
        failSession(parseError);
        socket.close(1002, "Invalid protocol message");
        return;
      }

      if (!Check(AsrServerMessageSchema, message)) {
        const schemaError = new Error("ASR server sent an unsupported protocol message");
        failSession(schemaError);
        socket.close(1002, "Unsupported protocol message");
        return;
      }

      const typedMessage = message as AsrServerMessage;
      if (typedMessage.type === "session.ready") {
        ready = true;
        readyResolve();
      } else if (typedMessage.type === "transcript.partial") {
        for (const handler of updates) {
          handler({ utteranceId: typedMessage.utteranceId, text: typedMessage.text, final: false });
        }
      } else if (typedMessage.type === "transcript.final") {
        for (const handler of updates) {
          handler({ utteranceId: typedMessage.utteranceId, text: typedMessage.text, final: true });
        }
      } else if (typedMessage.type === "error") {
        const serverError = new Error(
          `ASR server error (${typedMessage.code}): ${typedMessage.message}`,
        );
        failSession(serverError);
        socket.close(1011, "ASR server error");
      }
    });
    socket.addEventListener("error", () => {
      failSession(new Error("ASR WebSocket connection failed"));
    });
    socket.addEventListener("close", (event) => {
      if (!closedByClient) {
        failSession(new Error(`ASR WebSocket closed unexpectedly (${event.code})`));
      }
    });

    function failSession(error: Error): void {
      if (!ready) {
        readyReject(error);
      } else if (!sessionFailed) {
        sessionFailed = true;
        for (const handler of errors) handler(error);
      }
    }

    const readyTimeout = setTimeout(() => {
      readyReject(new Error("Timed out waiting for the ASR server"));
    }, ASR_READY_TIMEOUT_MS);
    try {
      await readyPromise;
    } catch (error) {
      socket.close();
      throw error;
    } finally {
      clearTimeout(readyTimeout);
    }

    return {
      onTranscript(handler) {
        updates.add(handler);
        return () => updates.delete(handler);
      },
      onError(handler) {
        errors.add(handler);
        return () => errors.delete(handler);
      },
      startUtterance(utteranceId) {
        sendControl(socket, { type: "utterance.start", utteranceId });
      },
      sendAudio(pcm) {
        if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
          throw new Error("ASR audio frames must contain whole PCM samples");
        }
        if (socket.bufferedAmount > MAX_BUFFERED_AUDIO_BYTES) {
          throw new Error("ASR audio send queue exceeded its limit");
        }
        if (socket.readyState !== WebSocket.OPEN) {
          throw new Error("ASR session is not connected");
        }
        socket.send(pcm);
      },
      finishUtterance(utteranceId) {
        sendControl(socket, { type: "utterance.end", utteranceId });
      },
      close() {
        updates.clear();
        errors.clear();
        if (socket.readyState < WebSocket.CLOSING) {
          closedByClient = true;
          socket.close(1000, "Session finished");
        }
      },
    };
  }
}

function sendControl(socket: WebSocket, message: AsrClientMessage): void {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new Error("ASR session is not connected");
  }
  if (!Check(AsrClientMessageSchema, message)) {
    throw new Error("Invalid ASR client protocol message");
  }
  socket.send(JSON.stringify(message));
}
