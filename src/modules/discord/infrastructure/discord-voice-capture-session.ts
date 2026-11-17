import { randomUUID } from "node:crypto";
import prism from "prism-media";
import {
  AudioPlayer,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type DiscordGatewayAdapterCreator,
} from "@discordjs/voice";

import type { AsrClient, AsrConnection, AsrRequest } from "@modules/asr/domain/asr-client";
import { VadStream, type VadEvent } from "@modules/vad/domain/vad-stream";
import { SileroVadModel } from "@modules/vad/infrastructure/silero-vad-model";
import {
  DiscordVoicePlayback,
  type DiscordVoicePlaybackOptions,
  type VoiceLogger,
  type VoicePlaybackConnection,
} from "./discord-voice-playback";

const VOICE_READY_TIMEOUT_MS = 15_000;
const VAD_FRAME_DURATION_MS = 32;
const MAX_VAD_IDLE_MS = 60_000;

export interface VoiceAudioDecoder extends NodeJS.WritableStream {
  destroy(): void;
  on(event: "data", listener: (pcm: unknown) => void): this;
  once(event: "data", listener: (pcm: Buffer) => void): this;
  once(event: "end", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export interface VoiceReceivedAudioStream {
  destroy(): void;
  pipe(destination: VoiceAudioDecoder): unknown;
  on(event: "data", listener: () => void): unknown;
  once(event: "data", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface VoiceActivityDetector {
  push(pcm: Uint8Array): Promise<readonly VadEvent[]>;
  pushSilence(durationMs: number): Promise<readonly VadEvent[]>;
  finish(): readonly VadEvent[];
  reset(): void;
  close?(): Promise<void>;
}

export interface VoiceCaptureConnection extends VoicePlaybackConnection {
  destroy(): void;
  readonly receiver: {
    readonly speaking: {
      on(event: "start", listener: (userId: string) => void): unknown;
      off(event: "start", listener: (userId: string) => void): unknown;
    };
    subscribe(
      userId: string,
      options: { readonly end: { readonly behavior: EndBehaviorType.Manual } },
    ): VoiceReceivedAudioStream;
  };
}

interface ActiveInput {
  readonly receivedAudio: { destroy(): void };
  readonly decoder: VoiceAudioDecoder;
  silenceTimer?: ReturnType<typeof setInterval>;
  lastPacketAt: number;
  processing: Promise<void>;
  pendingSilenceFrames: number;
  silenceQueued: boolean;
  closed: boolean;
}

interface ActiveAsrRequest {
  readonly request: AsrRequest;
  readonly requestId: string;
  audioBytes: number;
  readonly resolveTranscript: (text: string) => void;
}

export interface DiscordVoiceCaptureSessionOptions extends Pick<
  DiscordVoicePlaybackOptions,
  "audioPlayerFactory" | "audioResourceFactory" | "reactionPresets" | "tts"
> {
  readonly adapterCreator: DiscordGatewayAdapterCreator;
  readonly asr: AsrClient;
  readonly connectVoice?: (options: {
    readonly adapterCreator: DiscordGatewayAdapterCreator;
    readonly channelId: string;
    readonly guildId: string;
    readonly selfDeaf: boolean;
  }) => Promise<VoiceCaptureConnection>;
  readonly createDecoder?: () => VoiceAudioDecoder;
  readonly createVad?: () => Promise<VoiceActivityDetector>;
  readonly guildId: string;
  readonly language: string;
  readonly logger?: VoiceLogger;
  readonly onError?: (error: Error) => void;
  readonly onTranscript: (text: string, requestId?: string) => Promise<void>;
  readonly userId: string;
  readonly voiceChannelId: string;
}

export class DiscordVoiceCaptureSession {
  private readonly logger?: VoiceLogger;
  private readonly playback: DiscordVoicePlayback;
  private connection?: VoiceCaptureConnection;
  private asrConnection?: AsrConnection;
  private vad?: VoiceActivityDetector;
  private activeInput?: ActiveInput;
  private activeAsrRequest?: ActiveAsrRequest;
  private transcriptQueue: Promise<void> = Promise.resolve();
  private speakingListener?: (userId: string) => void;
  private stopped = false;
  private readonly speechStartListeners = new Set<() => void>();

  constructor(private readonly options: DiscordVoiceCaptureSessionOptions) {
    this.logger = options.logger?.child({
      component: "discord-voice-capture-session",
      guildId: options.guildId,
      voiceChannelId: options.voiceChannelId,
      userId: options.userId,
    });
    this.playback = new DiscordVoicePlayback({
      audioPlayerFactory: options.audioPlayerFactory,
      audioResourceFactory: options.audioResourceFactory,
      logger: this.logger,
      reactionPresets: options.reactionPresets,
      tts: options.tts,
    });
  }

  async start(): Promise<void> {
    this.logger?.info({ event: "discord_voice_asr_connecting" }, "Connecting to ASR server");
    this.asrConnection = await this.options.asr.connect();
    this.logger?.info({ event: "discord_voice_asr_connected" }, "Connected to ASR server");
    this.asrConnection.onError((error) => {
      this.logger?.error(
        { err: error, event: "discord_voice_asr_connection_failed" },
        "ASR connection failed",
      );
      this.options.onError?.(error);
      void this.stop();
    });
    this.logger?.info({ event: "discord_voice_vad_loading" }, "Loading voice activity detector");
    this.vad = await (this.options.createVad?.() ?? createDefaultVad());
    this.logger?.info({ event: "discord_voice_vad_ready" }, "Voice activity detector is ready");

    this.logger?.info({ event: "discord_voice_connecting" }, "Connecting to Discord voice channel");
    const connection = await (this.options.connectVoice?.({
      adapterCreator: this.options.adapterCreator,
      channelId: this.options.voiceChannelId,
      guildId: this.options.guildId,
      selfDeaf: false,
    }) ??
      connectDefaultVoice(
        {
          adapterCreator: this.options.adapterCreator,
          channelId: this.options.voiceChannelId,
          guildId: this.options.guildId,
          selfDeaf: false,
        },
        this.logger,
      ));
    this.connection = connection;
    this.playback.start(connection);

    this.speakingListener = (userId) => {
      if (userId === this.options.userId) this.receiveUtterance();
    };
    connection.receiver.speaking.on("start", this.speakingListener);
    this.logger?.info(
      { event: "discord_voice_capture_ready" },
      "Listening for the session user's voice",
    );
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.speechStartListeners.clear();
    this.playback.stop();
    this.activeAsrRequest?.resolveTranscript("");
    this.activeAsrRequest = undefined;
    if (this.activeInput) {
      this.activeInput.closed = true;
      clearInterval(this.activeInput.silenceTimer);
    }
    this.activeInput?.receivedAudio.destroy();
    this.activeInput?.decoder.destroy();
    this.activeInput = undefined;
    if (this.connection && this.speakingListener) {
      this.connection.receiver.speaking.off("start", this.speakingListener);
    }
    this.connection?.destroy();
    this.connection = undefined;
    this.asrConnection?.close();
    this.asrConnection = undefined;
    await this.vad?.close?.();
    this.vad = undefined;
    this.logger?.info({ event: "discord_voice_capture_stopped" }, "Stopped voice capture");
  }

  private receiveUtterance(): void {
    const connection = this.connection;
    const asrConnection = this.asrConnection;
    const vad = this.vad;
    if (!connection || !asrConnection || !vad || this.stopped || this.activeInput) return;
    this.logger?.info(
      { event: "discord_voice_input_started" },
      "Subscribing to the session user's voice audio",
    );
    const receivedAudio = connection.receiver.subscribe(this.options.userId, {
      end: { behavior: EndBehaviorType.Manual },
    });
    const decoder: VoiceAudioDecoder =
      this.options.createDecoder?.() ??
      new prism.opus.Decoder({ channels: 2, frameSize: 960, rate: 48_000 });
    const input: ActiveInput = {
      receivedAudio,
      decoder,
      processing: Promise.resolve(),
      lastPacketAt: performance.now(),
      pendingSilenceFrames: 0,
      silenceQueued: false,
      closed: false,
    };
    this.activeInput = input;
    receivedAudio.once("data", () => {
      this.logger?.info(
        { event: "discord_voice_audio_received" },
        "Received the first voice audio packet",
      );
    });
    receivedAudio.on("data", () => {
      input.lastPacketAt = performance.now();
    });
    receivedAudio.pipe(decoder);
    decoder.once("data", (pcm: Buffer) => {
      this.logger?.info(
        { event: "discord_voice_audio_decoded", audioBytes: pcm.byteLength },
        "Decoded the first voice audio frame",
      );
    });
    decoder.on("data", (pcm: unknown) => {
      if (input.closed || !Buffer.isBuffer(pcm)) return;
      input.processing = this.runInputStep(input.processing, async () => {
        await this.handleVadEvents(await vad.push(downsampleTo16KhzMono(pcm)), asrConnection);
      });
    });
    const stopInput = (): void => {
      if (this.activeInput !== input) return;
      input.closed = true;
      clearInterval(input.silenceTimer);
      receivedAudio.destroy();
      decoder.destroy();
      input.processing = this.runInputStep(
        input.processing,
        async () => {
          await this.handleVadEvents(vad.finish(), asrConnection);
          vad.reset();
        },
        () => {
          if (this.activeInput === input) this.activeInput = undefined;
        },
      );
    };
    input.silenceTimer = setInterval(() => {
      const idleMs = performance.now() - input.lastPacketAt;
      if (idleMs >= MAX_VAD_IDLE_MS) {
        stopInput();
        return;
      }
      if (idleMs < VAD_FRAME_DURATION_MS) return;
      input.pendingSilenceFrames += 1;
      if (input.silenceQueued) return;
      input.silenceQueued = true;
      input.processing = this.runInputStep(
        input.processing,
        async () => {
          while (input.pendingSilenceFrames > 0 && !input.closed) {
            input.pendingSilenceFrames -= 1;
            await this.handleVadEvents(await vad.pushSilence(VAD_FRAME_DURATION_MS), asrConnection);
          }
        },
        () => {
          input.silenceQueued = false;
        },
      );
    }, VAD_FRAME_DURATION_MS);
    decoder.once("end", () => {
      if (!this.stopped && !input.closed)
        this.failVoiceCapture(new Error("Discord voice decoder ended unexpectedly"));
    });
    decoder.once("error", (error: Error) => {
      this.logger?.warn(
        { err: error, event: "discord_voice_opus_decode_failed" },
        "Failed to decode Discord voice audio",
      );
      if (!input.closed) this.failVoiceCapture(error);
    });
    receivedAudio.once("error", (error: Error) => {
      if (!input.closed) this.failVoiceCapture(error);
    });
  }

  private async runInputStep(
    previous: Promise<void>,
    step: () => Promise<void>,
    onFinally?: () => void,
  ): Promise<void> {
    await previous;
    try {
      await step();
    } catch (error) {
      this.failVoiceCapture(error);
    } finally {
      onFinally?.();
    }
  }

  private async enqueueTranscriptDelivery(
    previous: Promise<void>,
    transcriptPromise: Promise<{ text: string; receivedAt: number }>,
    requestId: string,
    queuedAt: number,
  ): Promise<void> {
    await previous;
    const { text, receivedAt } = await transcriptPromise;
    if (this.stopped || !text.trim()) return;
    const deliveryStartedAt = performance.now();
    this.logger?.info(
      {
        event: "discord_voice_transcript_delivery_started",
        requestId,
        asrResultWaitMs: Math.round(receivedAt - queuedAt),
        resultQueueWaitMs: Math.round(deliveryStartedAt - receivedAt),
      },
      "Delivering an ASR transcript to the conversation",
    );
    let failed = false;
    try {
      await this.options.onTranscript(text, requestId);
    } catch (error) {
      failed = true;
      this.logger?.warn(
        { err: error, event: "discord_voice_transcript_processing_failed", requestId },
        "Failed to process a voice transcript",
      );
    } finally {
      this.logger?.info(
        {
          event: "discord_voice_transcript_delivery_completed",
          requestId,
          durationMs: Math.round(performance.now() - deliveryStartedAt),
          failed,
        },
        "Finished delivering an ASR transcript",
      );
    }
  }

  private async handleVadEvents(
    events: readonly VadEvent[],
    asrConnection: AsrConnection,
  ): Promise<void> {
    for (const event of events) {
      if (event.type === "speech-start") {
        this.playback.onSpeechStart();
        for (const listener of this.speechStartListeners) listener();
        if (this.activeAsrRequest) continue;
        const requestId = randomUUID();
        try {
          const request = asrConnection.start({ requestId, language: this.options.language });
          const queuedAt = performance.now();
          const transcriptResult = Promise.withResolvers<{ text: string; receivedAt: number }>();
          const resolveTranscript = (text: string) =>
            transcriptResult.resolve({ text, receivedAt: performance.now() });
          this.activeAsrRequest = {
            request,
            requestId,
            audioBytes: event.pcm.byteLength,
            resolveTranscript,
          };
          this.logger?.info(
            { event: "discord_voice_speech_started", requestId },
            "Detected speech and started an ASR request",
          );
          this.transcriptQueue = this.enqueueTranscriptDelivery(
            this.transcriptQueue,
            transcriptResult.promise,
            requestId,
            queuedAt,
          );
          request.write(event.pcm);
        } catch (error) {
          this.failVoiceCapture(error);
        }
      } else if (event.type === "audio") {
        try {
          const active = this.activeAsrRequest;
          if (active) {
            active.request.write(event.pcm);
            active.audioBytes += event.pcm.byteLength;
          }
        } catch (error) {
          this.logger?.warn(
            { err: error, event: "discord_voice_audio_send_failed" },
            "Failed to forward voice audio to ASR",
          );
          this.finishAsrRequest();
        }
      } else {
        this.playback.onSpeechEnd();
        this.finishAsrRequest();
      }
    }
  }

  private finishAsrRequest(): void {
    const active = this.activeAsrRequest;
    if (!active) return;
    this.activeAsrRequest = undefined;
    if (this.stopped) {
      active.resolveTranscript("");
      return;
    }
    const startedAt = performance.now();
    this.logger?.info(
      {
        event: "discord_voice_asr_committed",
        requestId: active.requestId,
        audioBytes: active.audioBytes,
      },
      "Committed voice audio for transcription",
    );
    void this.commitAsrRequest(active, startedAt);
  }

  private async commitAsrRequest(active: ActiveAsrRequest, startedAt: number): Promise<void> {
    try {
      const { text } = await active.request.commit();
      this.logger?.info(
        {
          event: "discord_voice_asr_completed",
          requestId: active.requestId,
          durationMs: Math.round(performance.now() - startedAt),
          textLength: text.length,
          empty: !text.trim(),
        },
        "Received an ASR transcript",
      );
      active.resolveTranscript(text);
    } catch (error) {
      active.resolveTranscript("");
      this.logger?.warn(
        { err: error, event: "discord_voice_asr_request_failed", requestId: active.requestId },
        "ASR request failed",
      );
    }
  }

  speak(text: string, toolCallId?: string): Promise<void> {
    return this.playback.speak(text, toolCallId);
  }

  speakInBackground(text: string, toolCallId?: string): Promise<void> {
    return this.playback.speakInBackground(text, toolCallId);
  }

  playReaction(reaction: string, signal: AbortSignal): Promise<boolean> {
    return this.playback.playReaction(reaction, signal);
  }

  subscribeSpeechStart(listener: () => void): () => void {
    this.speechStartListeners.add(listener);
    return () => this.speechStartListeners.delete(listener);
  }

  async flushInput(): Promise<void> {
    await this.activeInput?.processing;
  }

  async flush(): Promise<void> {
    await this.flushInput();
    await this.transcriptQueue;
  }

  async waitForReactionsLoaded(): Promise<void> {
    await this.playback.waitForReactionsLoaded();
  }

  private failVoiceCapture(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.logger?.error(
      { err: normalized, event: "discord_voice_vad_failed" },
      "Voice activity detection failed",
    );
    this.activeAsrRequest?.resolveTranscript("");
    this.activeAsrRequest = undefined;
    this.options.onError?.(normalized);
    void this.stop();
  }
}

async function createDefaultVad(): Promise<VoiceActivityDetector> {
  const model = await SileroVadModel.create();
  const stream = new VadStream(model);
  return {
    push: (pcm) => stream.push(pcm),
    pushSilence: (durationMs) => stream.pushSilence(durationMs),
    finish: () => stream.finish(),
    reset: () => stream.reset(),
    close: () => model.close(),
  };
}

async function connectDefaultVoice(
  options: {
    readonly adapterCreator: DiscordGatewayAdapterCreator;
    readonly channelId: string;
    readonly guildId: string;
    readonly selfDeaf: boolean;
  },
  logger?: VoiceLogger,
): Promise<VoiceCaptureConnection> {
  const connection = joinVoiceChannel(options);
  connection.on("stateChange", (previous, next) => {
    logger?.info(
      {
        event: "discord_voice_connection_state_changed",
        previousStatus: previous.status,
        status: next.status,
      },
      "Discord voice connection state changed",
    );
  });
  await entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT_MS);
  return {
    destroy: () => connection.destroy(),
    receiver: connection.receiver,
    subscribePlayer: (player) => {
      if (player instanceof AudioPlayer) connection.subscribe(player);
    },
  };
}

function downsampleTo16KhzMono(pcm48KhzStereo: Buffer): Uint8Array {
  const inputSamples = Math.floor(pcm48KhzStereo.byteLength / 2);
  const outputSamples = Math.floor(inputSamples / 6);
  const output = Buffer.allocUnsafe(outputSamples * 2);
  for (let outputIndex = 0; outputIndex < outputSamples; outputIndex += 1) {
    let sum = 0;
    const firstInputIndex = outputIndex * 6;
    for (let offset = 0; offset < 6; offset += 1) {
      sum += pcm48KhzStereo.readInt16LE((firstInputIndex + offset) * 2);
    }
    output.writeInt16LE(Math.round(sum / 6), outputIndex * 2);
  }
  return output;
}
