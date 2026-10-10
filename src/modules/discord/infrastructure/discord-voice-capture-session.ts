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

  constructor(private readonly options: DiscordVoiceCaptureSessionOptions) {}

  async start(): Promise<void> {
    this.asrConnection = await this.options.asr.connect();
    this.asrConnection.onError((error) => {
      this.options.logger?.error(
        { err: error, event: "discord_voice_asr_connection_failed" },
        "ASR connection failed",
      );
      this.options.onError?.(error);
      void this.stop();
    });
    this.vadModel = await SileroVadModel.create();
    this.vad = new VadStream(this.vadModel);

    const connection = joinVoiceChannel({
      adapterCreator: this.options.adapterCreator,
      channelId: this.options.voiceChannelId,
      guildId: this.options.guildId,
      selfDeaf: false,
    });
    this.connection = connection;
    await entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT_MS);
    this.audioPlayer = createAudioPlayer();
    this.audioPlayer.on("error", (error) => {
      this.options.logger?.warn(
        { err: error, event: "discord_voice_tts_playback_failed" },
        "Failed to play synthesized voice audio",
      );
    });
    connection.subscribe(this.audioPlayer);

    this.speakingListener = (userId) => {
      if (userId === this.options.userId) this.receiveUtterance();
    };
    connection.receiver.speaking.on("start", this.speakingListener);
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
  }

  private receiveUtterance(): void {
    const connection = this.connection;
    const asrConnection = this.asrConnection;
    const vad = this.vad;
    if (!connection || !asrConnection || !vad || this.stopped || this.activeInput) return;
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
    receivedAudio.on("data", () => {
      input.lastPacketAt = performance.now();
    });
    receivedAudio.pipe(decoder);
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
      this.options.logger?.warn(
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
          this.activeAsrRequest = { request, resolveTranscript };
          this.transcriptQueue = this.transcriptQueue.then(async () => {
            const text = await transcriptResult;
            if (this.stopped || !text.trim()) return;
            try {
              await this.options.onTranscript(text);
            } catch (error) {
              this.options.logger?.warn(
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
          this.activeAsrRequest?.request.write(event.pcm);
        } catch (error) {
          this.options.logger?.warn(
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
    void active.request
      .commit()
      .then(({ text }) => active.resolveTranscript(text))
      .catch((error: unknown) => {
        active.resolveTranscript("");
        this.options.logger?.warn(
          { err: error, event: "discord_voice_asr_request_failed" },
          "ASR request failed",
        );
      });
  }

  async speak(text: string): Promise<void> {
    const audioPlayer = this.audioPlayer;
    if (!audioPlayer || this.stopped) return;
    const audio = await this.options.tts.synthesize(text);
    if (this.stopped) return;
    audioPlayer.play(
      createAudioResource(Readable.from([Buffer.from(audio)]), { inputType: StreamType.Arbitrary }),
    );
    await entersState(audioPlayer, AudioPlayerStatus.Idle, 5 * 60_000);
  }

  private failVoiceCapture(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.options.logger?.error(
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
