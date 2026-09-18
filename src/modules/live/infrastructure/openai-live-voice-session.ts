import OpenAI from "openai";
import { LiveWS } from "openai/resources/live/ws";
import type * as LiveAPI from "openai/resources/live/live";
import type { Logger } from "pino";

import type { LiveVoiceSession, LiveVoiceSessionFactory } from "../ports/live-voice-session";

const LIVE_MODEL = "gpt-live-1";
const LIVE_AUDIO_RATE = 24_000;
const LIVE_SESSION_START_TIMEOUT_MS = 15_000;
const MAX_TRANSCRIPT_CHARACTERS = 12_000;
const MAX_COMMENTARY_CHARACTERS = 1_800;

export class OpenAiLiveVoiceSessionFactory implements LiveVoiceSessionFactory {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly logger: Logger,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  create(options: {
    instructions: string;
    onAudioOutput: (audio: Buffer) => void;
    onDelegation: (delegationId: string, transcript: string) => Promise<string>;
  }): LiveVoiceSession {
    return new OpenAiLiveVoiceSession(this.client, this.logger, options);
  }
}

class OpenAiLiveVoiceSession implements LiveVoiceSession {
  private socket?: LiveWS;
  private started = false;
  private stopped = false;
  private transcript = "";
  private inputAudioStarted = false;
  private outputAudioStarted = false;

  constructor(
    private readonly client: OpenAI,
    private readonly logger: Logger,
    private readonly options: {
      readonly instructions: string;
      readonly onAudioOutput: (audio: Buffer) => void;
      readonly onDelegation: (delegationId: string, transcript: string) => Promise<string>;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;

    const socket = new LiveWS(this.client, { reconnect: null });
    this.socket = socket;
    socket.on("event", (event) => this.handleEvent(event));
    socket.on("error", (error) => {
      this.logger.warn(
        { err: error, event: "openai_live_socket_error" },
        "OpenAI Live socket error",
      );
    });

    const started = this.waitForSessionStart(socket);
    socket.send({
      type: "session.start",
      session: {
        model: LIVE_MODEL,
        audio: {
          format: { type: "audio/pcm", rate: LIVE_AUDIO_RATE },
          output: { voice: "marin" },
        },
        delegation: { type: "client" },
        instructions: this.options.instructions,
      },
    });

    try {
      await withTimeout(started, LIVE_SESSION_START_TIMEOUT_MS);
      this.started = true;
      this.logger.info(
        { event: "openai_live_session_started", model: LIVE_MODEL },
        "OpenAI Live session started",
      );
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  pushInputAudio(audio: Buffer): void {
    if (!this.started || this.stopped || !this.socket || audio.length === 0) return;

    if (!this.inputAudioStarted) {
      this.inputAudioStarted = true;
      this.logger.info(
        { bytes: audio.length, event: "openai_live_input_audio_started" },
        "OpenAI Live input audio started",
      );
    }

    this.socket.send({
      type: "session.input_audio.append",
      audio: audio.toString("base64"),
    });
  }

  appendCommentary(content: string, delegationId: string | null): void {
    if (!this.started || this.stopped || !this.socket) return;

    const trimmed = content.trim();
    if (!trimmed) return;

    this.socket.send({
      type: "session.commentary.append",
      content: trimmed.slice(0, MAX_COMMENTARY_CHARACTERS),
      delegation_id: delegationId,
    });
  }

  stop(): void {
    if (this.stopped) return;

    this.stopped = true;
    this.socket?.close({ code: 1000, reason: "Discord voice session ended" });
    this.socket = undefined;
  }

  private handleEvent(event: LiveAPI.ServerEvent): void {
    switch (event.type) {
      case "session.input_transcript.delta":
      case "session.output_transcript.delta":
        this.appendTranscript(event.delta);
        return;
      case "session.output_audio.delta":
        if (!this.outputAudioStarted) {
          this.outputAudioStarted = true;
          this.logger.info(
            {
              bytes: Buffer.byteLength(event.delta, "base64"),
              event: "openai_live_output_started",
            },
            "OpenAI Live output audio started",
          );
        }
        this.options.onAudioOutput(Buffer.from(event.delta, "base64"));
        return;
      case "session.delegation.created":
        if (event.delegation.target === "client") {
          void this.handleDelegation(event.delegation.id);
        }
        return;
      case "error":
        this.logger.warn(
          { event: "openai_live_server_error", error: event.error },
          "OpenAI Live returned an error",
        );
        return;
      default:
        return;
    }
  }

  private appendTranscript(delta: string): void {
    this.transcript = `${this.transcript}${delta}`.slice(-MAX_TRANSCRIPT_CHARACTERS);
  }

  private async handleDelegation(delegationId: string): Promise<void> {
    try {
      const result = await this.options.onDelegation(delegationId, this.transcript.trim());
      this.appendCommentary(result, delegationId);
    } catch (error) {
      this.logger.error(
        { delegationId, err: error, event: "openai_live_delegation_failed" },
        "Failed to handle OpenAI Live delegation",
      );
      this.appendCommentary("ごめん、その処理は今うまくできませんでした。", delegationId);
    }
  }

  private waitForSessionStart(socket: LiveWS): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onStarted = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onClose = (code: number, reason: string): void => {
        cleanup();
        reject(new Error(`OpenAI Live socket closed before session start (${code}: ${reason})`));
      };
      const cleanup = (): void => {
        socket.off("session.started", onStarted);
        socket.off("error", onError);
        socket.off("close", onClose);
      };

      socket.once("session.started", onStarted);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for OpenAI Live session start")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
