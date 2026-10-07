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

import type { StreamingAsr, StreamingAsrSession } from "@modules/asr/domain/streaming-asr";

const VOICE_READY_TIMEOUT_MS = 15_000;
const SILENCE_DURATION_MS = 900;

export interface DiscordVoiceChatSessionOptions {
  readonly adapterCreator: DiscordGatewayAdapterCreator;
  readonly asr: StreamingAsr;
  readonly guildId: string;
  readonly language: string;
  readonly logger?: Logger;
  readonly onTranscript: (text: string) => Promise<void>;
  readonly userId: string;
  readonly voiceChannelId: string;
}

export class DiscordVoiceChatSession {
  private connection?: VoiceConnection;
  private asrSession?: StreamingAsrSession;
  private activeUtteranceId?: string;
  private speakingListener?: (userId: string) => void;
  private stopped = false;

  constructor(private readonly options: DiscordVoiceChatSessionOptions) {}

  async start(): Promise<void> {
    this.asrSession = await this.options.asr.connect({
      language: this.options.language,
      audio: { encoding: "pcm_s16le", sampleRateHz: 16_000, channels: 1 },
    });
    this.asrSession.onTranscript((update) => {
      if (!update.final || !update.text.trim()) return;
      void this.options.onTranscript(update.text).catch((error: unknown) => {
        this.options.logger?.warn(
          { err: error, event: "discord_voice_transcript_send_failed" },
          "Failed to send a voice transcript",
        );
      });
    });
    this.asrSession.onError((error) => {
      this.options.logger?.error(
        { err: error, event: "discord_voice_asr_failed" },
        "Streaming ASR session failed",
      );
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
    this.asrSession?.close();
    this.asrSession = undefined;
  }

  private receiveUtterance(): void {
    const connection = this.connection;
    const asrSession = this.asrSession;
    if (!connection || !asrSession || this.stopped || this.activeUtteranceId) return;

    const utteranceId = randomUUID();
    this.activeUtteranceId = utteranceId;
    let utteranceFinished = false;
    const finishUtterance = (): void => {
      if (utteranceFinished) return;
      utteranceFinished = true;
      if (this.activeUtteranceId === utteranceId) this.activeUtteranceId = undefined;
      if (!this.stopped) asrSession.finishUtterance(utteranceId);
    };
    asrSession.startUtterance(utteranceId);
    const receivedAudio = connection.receiver.subscribe(this.options.userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_DURATION_MS },
    });
    const decoder = new prism.opus.Decoder({ channels: 2, frameSize: 960, rate: 48_000 });
    receivedAudio.pipe(decoder);
    decoder.on("data", (pcm: Buffer) => {
      try {
        asrSession.sendAudio(downsampleTo16KhzMono(pcm));
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
