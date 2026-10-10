import { randomUUID } from "node:crypto";
import prism from "prism-media";
import type { Logger } from "pino";
import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from "@discordjs/voice";

import type { AsrClient, AsrConnection, AsrRequest } from "@modules/asr/domain/asr-client";

const VOICE_READY_TIMEOUT_MS = 15_000;
const SILENCE_DURATION_MS = 900;

export interface DiscordVoiceCaptureSessionOptions {
  readonly adapterCreator: DiscordGatewayAdapterCreator;
  readonly asr: AsrClient;
  readonly guildId: string;
  readonly language: string;
  readonly logger?: Logger;
  readonly onError?: (error: Error) => void;
  readonly onTranscript: (text: string) => Promise<void>;
  readonly userId: string;
  readonly voiceChannelId: string;
}

export class DiscordVoiceCaptureSession {
  private connection?: VoiceConnection;
  private asrConnection?: AsrConnection;
  private activeUtteranceId?: string;
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

    const connection = joinVoiceChannel({
      adapterCreator: this.options.adapterCreator,
      channelId: this.options.voiceChannelId,
      guildId: this.options.guildId,
      selfDeaf: false,
    });
    this.connection = connection;
    await entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT_MS);

    this.speakingListener = (userId) => {
      if (userId === this.options.userId) this.receiveUtterance();
    };
    connection.receiver.speaking.on("start", this.speakingListener);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.connection && this.speakingListener) {
      this.connection.receiver.speaking.off("start", this.speakingListener);
    }
    this.connection?.destroy();
    this.connection = undefined;
    this.asrConnection?.close();
    this.asrConnection = undefined;
  }

  private receiveUtterance(): void {
    const connection = this.connection;
    const asrConnection = this.asrConnection;
    if (!connection || !asrConnection || this.stopped || this.activeUtteranceId) return;

    const utteranceId = randomUUID();
    this.activeUtteranceId = utteranceId;
    let request: AsrRequest;
    try {
      request = asrConnection.start({ requestId: utteranceId, language: this.options.language });
    } catch (error) {
      this.activeUtteranceId = undefined;
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let resolveTranscript!: (text: string) => void;
    const transcriptResult = new Promise<string>((resolve) => {
      resolveTranscript = resolve;
    });
    this.transcriptQueue = this.transcriptQueue.then(async () => {
      const text = await transcriptResult;
      if (this.stopped || !text.trim()) return;
      try {
        await this.options.onTranscript(text);
      } catch (error) {
        this.options.logger?.warn(
          { err: error, event: "discord_voice_transcript_send_failed" },
          "Failed to send a voice transcript",
        );
      }
    });
    let utteranceFinished = false;
    const finishUtterance = (): void => {
      if (utteranceFinished) return;
      utteranceFinished = true;
      if (this.activeUtteranceId === utteranceId) this.activeUtteranceId = undefined;
      if (this.stopped) {
        resolveTranscript("");
        return;
      }
      void request
        .commit()
        .then(({ text }) => resolveTranscript(text))
        .catch((error: unknown) => {
          resolveTranscript("");
          this.options.logger?.warn(
            { err: error, event: "discord_voice_asr_request_failed", requestId: utteranceId },
            "ASR request failed",
          );
        });
    };
    const receivedAudio = connection.receiver.subscribe(this.options.userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_DURATION_MS },
    });
    const decoder = new prism.opus.Decoder({ channels: 2, frameSize: 960, rate: 48_000 });
    receivedAudio.pipe(decoder);
    decoder.on("data", (pcm: Buffer) => {
      try {
        request.write(downsampleTo16KhzMono(pcm));
      } catch (error) {
        this.options.logger?.warn(
          { err: error, event: "discord_voice_audio_send_failed" },
          "Failed to forward voice audio to ASR",
        );
        finishUtterance();
        receivedAudio.destroy();
        decoder.destroy();
      }
    });
    decoder.once("end", finishUtterance);
    decoder.once("error", (error: Error) => {
      this.options.logger?.warn(
        { err: error, event: "discord_voice_opus_decode_failed" },
        "Failed to decode Discord voice audio",
      );
      finishUtterance();
      receivedAudio.destroy();
    });
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
