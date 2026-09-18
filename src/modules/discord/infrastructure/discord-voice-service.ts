import { PassThrough } from "node:stream";

import {
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
  StreamType,
  VoiceConnectionStatus,
  type AudioReceiveStream,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import OpusScript from "opusscript";
import type { Logger } from "pino";

import type { DiscordAccessPolicy } from "../domain/discord-access-policy";
import type {
  DiscordVoiceAdapterProvider,
  DiscordVoiceCommandHandler,
  DiscordVoiceDelegationRequest,
  DiscordVoiceJoinRequest,
  DiscordVoiceLeaveRequest,
} from "../ports/discord-voice-service";
import type {
  LiveVoiceSession,
  LiveVoiceSessionFactory,
} from "@modules/live/ports/live-voice-session";

const VOICE_CONNECTION_TIMEOUT_MS = 15_000;
const VOICE_INPUT_SILENCE_MS = 100;
const DISCORD_AUDIO_RATE = 48_000;

const LIVE_VOICE_INSTRUCTIONS = `
You are the real-time voice front end for a Discord conversation.
Speak naturally and keep ordinary replies concise.
When the user asks for work that needs substantial reasoning, code changes, research, or other backend processing, delegate it to the client application. The client application will return the result as commentary for you to communicate.
Do not claim that delegated work is complete until the client returns its result.
`;

interface InputSubscription {
  readonly opus: AudioReceiveStream;
  readonly disposeDecoder: () => void;
}

interface ActiveVoiceSession {
  readonly connection: VoiceConnection;
  readonly live: LiveVoiceSession;
  readonly output: PassThrough;
  readonly player: AudioPlayer;
  readonly inputSubscriptions: Map<string, InputSubscription>;
  readonly speakingListener: (userId: string) => void;
  readonly voiceChannelId: string;
}

export class DiscordVoiceService implements DiscordVoiceCommandHandler {
  private readonly sessions = new Map<string, ActiveVoiceSession>();
  private readonly logger: Logger;

  constructor(
    private readonly adapterProvider: DiscordVoiceAdapterProvider,
    private readonly accessPolicy: DiscordAccessPolicy,
    private readonly liveSessionFactory: LiveVoiceSessionFactory,
    private readonly systemPrompt: string,
    private readonly onDelegation: (request: DiscordVoiceDelegationRequest) => Promise<string>,
    logger: Logger,
  ) {
    this.logger = logger.child({ component: "discord-voice-service" });
  }

  async join(request: DiscordVoiceJoinRequest): Promise<string> {
    if (
      !this.accessPolicy.canReceive({ guildId: request.guildId, channelId: request.voiceChannelId })
    ) {
      return "このボイスチャンネルでは音声会話を利用できません。";
    }

    const existing = this.sessions.get(request.guildId);
    if (existing?.voiceChannelId === request.voiceChannelId) {
      return "すでにこのボイスチャンネルに参加しています。";
    }
    if (existing) {
      await this.leaveGuild(request.guildId);
    }

    const connection = joinVoiceChannel({
      adapterCreator: this.adapterProvider.getVoiceAdapter(request.guildId),
      channelId: request.voiceChannelId,
      guildId: request.guildId,
      selfDeaf: false,
      selfMute: false,
    });
    let output: PassThrough | undefined;
    let player: AudioPlayer | undefined;
    let live: LiveVoiceSession | undefined;
    let speakingListener: ((userId: string) => void) | undefined;
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, VOICE_CONNECTION_TIMEOUT_MS);

      const outputStream = new PassThrough();
      output = outputStream;
      player = createAudioPlayer();
      player.on("error", (error) => {
        this.logger.warn(
          { err: error, event: "discord_voice_output_failed", guildId: request.guildId },
          "Failed to play Discord voice output",
        );
      });
      player.play(createAudioResource(outputStream, { inputType: StreamType.Raw }));
      connection.subscribe(player);

      const liveSession = this.liveSessionFactory.create({
        instructions: `${this.systemPrompt}\n${LIVE_VOICE_INSTRUCTIONS}`,
        onAudioOutput: (audio) => {
          if (!outputStream.destroyed && !outputStream.writableEnded) {
            outputStream.write(toDiscordPcm(audio));
          }
        },
        onDelegation: (delegationId, transcript) =>
          this.onDelegation({
            delegationId,
            guildId: request.guildId,
            transcript,
          }),
      });
      live = liveSession;
      await liveSession.start();

      const inputSubscriptions = new Map<string, InputSubscription>();
      speakingListener = (userId: string): void => {
        this.startInputSubscription(
          request.guildId,
          connection,
          liveSession,
          userId,
          inputSubscriptions,
        );
      };
      connection.receiver.speaking.on("start", speakingListener);

      this.sessions.set(request.guildId, {
        connection,
        inputSubscriptions,
        live: liveSession,
        output: outputStream,
        player,
        speakingListener,
        voiceChannelId: request.voiceChannelId,
      });

      return "ボイスチャンネルに参加しました。話しかけてください。";
    } catch (error) {
      if (speakingListener) connection.receiver.speaking.off("start", speakingListener);
      live?.stop();
      output?.end();
      player?.stop(true);
      connection.destroy();
      throw error;
    }
  }

  async leave(request: DiscordVoiceLeaveRequest): Promise<string> {
    if (!this.sessions.has(request.guildId)) {
      return "参加中のボイスチャンネルはありません。";
    }

    await this.leaveGuild(request.guildId);
    return "ボイスチャンネルから退出しました。";
  }

  async stop(): Promise<void> {
    const guildIds = [...this.sessions.keys()];
    await Promise.all(guildIds.map((guildId) => this.leaveGuild(guildId)));
  }

  private startInputSubscription(
    guildId: string,
    connection: VoiceConnection,
    live: LiveVoiceSession,
    userId: string,
    inputSubscriptions: Map<string, InputSubscription>,
  ): void {
    if (userId === this.adapterProvider.getCurrentUserId()) return;
    if (inputSubscriptions.has(userId)) return;

    const opus = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: VOICE_INPUT_SILENCE_MS },
    });
    const decoder = new OpusScript(DISCORD_AUDIO_RATE, 2, OpusScript.Application.VOIP);
    let decoderDisposed = false;
    const disposeDecoder = (): void => {
      if (decoderDisposed) return;
      decoderDisposed = true;
      decoder.delete();
    };
    const subscription = { disposeDecoder, opus };
    inputSubscriptions.set(userId, subscription);

    const onError = (error: Error): void => {
      this.logger.debug(
        { err: error, event: "discord_voice_input_failed", guildId, userId },
        "Discord voice input stream ended with an error",
      );
    };
    opus.on("error", onError);
    opus.once("close", () => {
      disposeDecoder();
      if (inputSubscriptions.get(userId) === subscription) {
        inputSubscriptions.delete(userId);
      }
    });
    opus.on("data", (chunk: Buffer) => {
      try {
        live.pushInputAudio(toLivePcm(decoder.decode(chunk)));
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async leaveGuild(guildId: string): Promise<void> {
    const session = this.sessions.get(guildId);
    if (!session) return;

    this.sessions.delete(guildId);
    session.connection.receiver.speaking.off("start", session.speakingListener);
    for (const { disposeDecoder, opus } of session.inputSubscriptions.values()) {
      opus.destroy();
      disposeDecoder();
    }
    session.inputSubscriptions.clear();
    session.live.stop();
    session.output.end();
    session.player.stop(true);
    session.connection.destroy();
  }
}

export function toLivePcm(discordPcm: Buffer): Buffer {
  const frameCount = Math.floor(discordPcm.length / 4);
  const outputFrameCount = Math.ceil(frameCount / 2);
  const livePcm = Buffer.alloc(outputFrameCount * 2);

  for (
    let inputFrame = 0, outputFrame = 0;
    inputFrame < frameCount;
    inputFrame += 2, outputFrame += 1
  ) {
    const inputOffset = inputFrame * 4;
    const left = discordPcm.readInt16LE(inputOffset);
    const right = discordPcm.readInt16LE(inputOffset + 2);
    livePcm.writeInt16LE(Math.round((left + right) / 2), outputFrame * 2);
  }

  return livePcm;
}

export function toDiscordPcm(livePcm: Buffer): Buffer {
  const sampleCount = Math.floor(livePcm.length / 2);
  const discordPcm = Buffer.alloc(sampleCount * 4);

  for (let sample = 0; sample < sampleCount; sample += 1) {
    const value = livePcm.readInt16LE(sample * 2);
    const outputOffset = sample * 4;
    discordPcm.writeInt16LE(value, outputOffset);
    discordPcm.writeInt16LE(value, outputOffset + 2);
  }

  return discordPcm;
}
