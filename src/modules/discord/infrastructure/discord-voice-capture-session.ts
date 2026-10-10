import { randomUUID } from "node:crypto";
import prism from "prism-media";
import type { Logger } from "pino";
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  StreamType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from "@discordjs/voice";
import { Readable } from "node:stream";

import type { AsrClient, AsrConnection, AsrRequest } from "@modules/asr/domain/asr-client";
import type { TextToSpeech } from "@modules/tts/infrastructure/sbv2-tts";
import { VadStream, type VadEvent } from "@modules/vad/domain/vad-stream";
import { SileroVadModel } from "@modules/vad/infrastructure/silero-vad-model";

const VOICE_READY_TIMEOUT_MS = 15_000;
const VAD_FRAME_DURATION_MS = 32;
const MAX_VAD_IDLE_MS = 60_000;

interface ActiveInput {
  readonly receivedAudio: { destroy(): void };
  readonly decoder: {
    destroy(): void;
    on(event: "data", listener: (pcm: Buffer) => void): unknown;
    once(event: "end", listener: () => void): unknown;
    once(event: "error", listener: (error: Error) => void): unknown;
  };
  silenceTimer: ReturnType<typeof setInterval>;
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

export interface DiscordVoiceCaptureSessionOptions {
  readonly adapterCreator: DiscordGatewayAdapterCreator;
  readonly asr: AsrClient;
  readonly guildId: string;
  readonly language: string;
  readonly logger?: Logger;
  readonly onError?: (error: Error) => void;
  readonly onTranscript: (text: string) => Promise<void>;
  readonly tts: TextToSpeech;
  readonly userId: string;
  readonly voiceChannelId: string;
}

export class DiscordVoiceCaptureSession {
  private readonly logger?: Logger;
  private connection?: VoiceConnection;
  private audioPlayer?: ReturnType<typeof createAudioPlayer>;
  private asrConnection?: AsrConnection;
  private vad?: VadStream;
  private vadModel?: SileroVadModel;
  private activeInput?: ActiveInput;
  private activeAsrRequest?: ActiveAsrRequest;
  private transcriptQueue: Promise<void> = Promise.resolve();
  private speakingListener?: (userId: string) => void;
  private stopped = false;

  constructor(private readonly options: DiscordVoiceCaptureSessionOptions) {
    this.logger = options.logger?.child({
      component: "discord-voice-capture-session",
      guildId: options.guildId,
      voiceChannelId: options.voiceChannelId,
      userId: options.userId,
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
    this.vadModel = await SileroVadModel.create();
    this.vad = new VadStream(this.vadModel);
    this.logger?.info({ event: "discord_voice_vad_ready" }, "Voice activity detector is ready");

    this.logger?.info({ event: "discord_voice_connecting" }, "Connecting to Discord voice channel");
    const connection = joinVoiceChannel({
      adapterCreator: this.options.adapterCreator,
      channelId: this.options.voiceChannelId,
      guildId: this.options.guildId,
      selfDeaf: false,
    });
    this.connection = connection;
    connection.on("stateChange", (previous, next) => {
      this.logger?.info(
        {
          event: "discord_voice_connection_state_changed",
          previousStatus: previous.status,
          status: next.status,
        },
        "Discord voice connection state changed",
      );
    });
    await entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT_MS);
    this.audioPlayer = createAudioPlayer();
    this.audioPlayer.on("error", (error) => {
      this.logger?.warn(
        { err: error, event: "discord_voice_tts_playback_failed" },
        "Failed to play synthesized voice audio",
      );
    });
    this.audioPlayer.on("stateChange", (previous, next) => {
      this.logger?.info(
        {
          event: "discord_voice_playback_state_changed",
          previousStatus: previous.status,
          status: next.status,
        },
        "Voice audio playback state changed",
      );
    });
    connection.subscribe(this.audioPlayer);

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
    this.audioPlayer?.stop(true);
    this.audioPlayer = undefined;
    this.asrConnection?.close();
    this.asrConnection = undefined;
    await this.vadModel?.close();
    this.vadModel = undefined;
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
    const decoder = new prism.opus.Decoder({ channels: 2, frameSize: 960, rate: 48_000 });
    const input: ActiveInput = {
      receivedAudio,
      decoder,
      processing: Promise.resolve(),
      lastPacketAt: performance.now(),
      silenceTimer: undefined as unknown as ReturnType<typeof setInterval>,
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
    decoder.on("data", (pcm) => {
      if (input.closed) return;
      input.processing = input.processing
        .then(async () => {
          await this.handleVadEvents(await vad.push(downsampleTo16KhzMono(pcm)), asrConnection);
        })
        .catch((error: unknown) => {
          this.failVoiceCapture(error);
        });
    });
    const stopInput = (): void => {
      if (this.activeInput !== input) return;
      input.closed = true;
      clearInterval(input.silenceTimer);
      receivedAudio.destroy();
      decoder.destroy();
      input.processing = input.processing
        .then(async () => {
          await this.handleVadEvents(vad.finish(), asrConnection);
          vad.reset();
        })
        .catch((error: unknown) => this.failVoiceCapture(error))
        .finally(() => {
          if (this.activeInput === input) this.activeInput = undefined;
        });
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
      input.processing = input.processing
        .then(async () => {
          while (input.pendingSilenceFrames > 0 && !input.closed) {
            input.pendingSilenceFrames -= 1;
            await this.handleVadEvents(await vad.pushSilence(VAD_FRAME_DURATION_MS), asrConnection);
          }
        })
        .catch((error: unknown) => {
          this.failVoiceCapture(error);
        })
        .finally(() => {
          input.silenceQueued = false;
        });
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

  private async handleVadEvents(
    events: readonly VadEvent[],
    asrConnection: AsrConnection,
  ): Promise<void> {
    for (const event of events) {
      if (event.type === "speech-start") {
        if (this.activeAsrRequest) continue;
        const requestId = randomUUID();
        try {
          const request = asrConnection.start({ requestId, language: this.options.language });
          let resolveTranscript!: (text: string) => void;
          const transcriptResult = new Promise<string>((resolve) => {
            resolveTranscript = resolve;
          });
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
          this.transcriptQueue = this.transcriptQueue.then(async () => {
            const text = await transcriptResult;
            if (this.stopped || !text.trim()) return;
            try {
              await this.options.onTranscript(text);
            } catch (error) {
              this.logger?.warn(
                { err: error, event: "discord_voice_transcript_processing_failed" },
                "Failed to process a voice transcript",
              );
            }
          });
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
    void active.request
      .commit()
      .then(({ text }) => {
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
      })
      .catch((error: unknown) => {
        active.resolveTranscript("");
        this.logger?.warn(
          { err: error, event: "discord_voice_asr_request_failed", requestId: active.requestId },
          "ASR request failed",
        );
      });
  }

  async speak(text: string): Promise<void> {
    const audioPlayer = this.audioPlayer;
    if (!audioPlayer || this.stopped) {
      this.logger?.warn(
        { event: "discord_voice_speak_skipped", stopped: this.stopped },
        "Voice playback is unavailable",
      );
      return;
    }
    const startedAt = performance.now();
    this.logger?.info(
      { event: "discord_voice_tts_started", textLength: text.length },
      "Synthesizing a voice reply",
    );
    const audio = await this.options.tts.synthesize(text).catch((error: unknown) => {
      this.logger?.warn(
        {
          err: error,
          event: "discord_voice_tts_failed",
          durationMs: Math.round(performance.now() - startedAt),
        },
        "Failed to synthesize a voice reply",
      );
      throw error;
    });
    this.logger?.info(
      {
        event: "discord_voice_tts_completed",
        durationMs: Math.round(performance.now() - startedAt),
        audioBytes: audio.byteLength,
      },
      "Synthesized a voice reply",
    );
    if (this.stopped) return;
    audioPlayer.play(
      createAudioResource(Readable.from([Buffer.from(audio)]), { inputType: StreamType.Arbitrary }),
    );
    await entersState(audioPlayer, AudioPlayerStatus.Idle, 5 * 60_000);
    this.logger?.info(
      {
        event: "discord_voice_speak_completed",
        durationMs: Math.round(performance.now() - startedAt),
      },
      "Finished playing the voice reply",
    );
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
