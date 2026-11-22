import { randomUUID } from "node:crypto";
import {
  AudioPlayer,
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  type AudioResource,
  type VoiceConnection,
} from "@discordjs/voice";
import { Readable } from "node:stream";

import type { TextToSpeech } from "@modules/tts/ports/text-to-speech";

export interface VoiceLogger {
  child(bindings: Record<string, unknown>): VoiceLogger;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface VoiceAudioPlayer {
  on(event: "error", listener: (error: Error) => void): unknown;
  on(
    event: "stateChange",
    listener: (
      previous: { readonly status: AudioPlayerStatus },
      next: { readonly status: AudioPlayerStatus },
    ) => void,
  ): unknown;
  play(resource: AudioResource): unknown;
  stop(force?: boolean): unknown;
}

export interface VoicePlaybackConnection {
  subscribePlayer(player: VoiceAudioPlayer): void;
}

export interface DiscordVoicePlaybackOptions {
  readonly audioPlayerFactory?: () => VoiceAudioPlayer;
  readonly audioResourceFactory?: (audio: Uint8Array) => AudioResource;
  readonly logger?: VoiceLogger;
  readonly tts: TextToSpeech;
}

export class DiscordVoicePlayback {
  private readonly logger?: VoiceLogger;
  private audioPlayer?: VoiceAudioPlayer;
  private stopped = false;
  private replyActive = false;
  private pendingReply?: {
    readonly text: string;
    readonly toolCallId?: string;
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
  };
  private currentPlayback?: {
    finish: (played: boolean, error?: Error) => void;
  };

  constructor(private readonly options: DiscordVoicePlaybackOptions) {
    this.logger = options.logger?.child({ component: "discord-voice-playback" });
  }

  start(connection: VoiceConnection | VoicePlaybackConnection): void {
    const player = this.options.audioPlayerFactory?.() ?? createAudioPlayer();
    this.audioPlayer = player;
    player.on("error", (error) => {
      const playback = this.currentPlayback;
      if (playback) {
        this.currentPlayback = undefined;
        playback.finish(false, error);
      }
      this.logger?.warn(
        { err: error, event: "discord_voice_tts_playback_failed" },
        "Failed to play synthesized voice audio",
      );
    });
    player.on("stateChange", (previous, next) => {
      if (next.status === AudioPlayerStatus.Idle && this.currentPlayback) {
        const playback = this.currentPlayback;
        this.currentPlayback = undefined;
        playback.finish(true);
      }
      this.logger?.info(
        {
          event: "discord_voice_playback_state_changed",
          previousStatus: previous.status,
          status: next.status,
        },
        "Voice audio playback state changed",
      );
    });
    if ("subscribePlayer" in connection) {
      connection.subscribePlayer(player);
    } else if (player instanceof AudioPlayer) {
      connection.subscribe(player);
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pendingReply?.resolve();
    this.pendingReply = undefined;
    const playback = this.currentPlayback;
    this.currentPlayback = undefined;
    playback?.finish(false);
    this.audioPlayer?.stop(true);
    this.audioPlayer = undefined;
  }

  speak(text: string, toolCallId?: string): Promise<void> {
    if (this.replyActive && !this.stopped) {
      return new Promise<void>((resolve, reject) => {
        this.pendingReply?.resolve();
        this.pendingReply = { text, toolCallId, resolve, reject };
      });
    }

    this.replyActive = true;
    return this.playReplyAndDrain(text, toolCallId);
  }

  speakInBackground(text: string, toolCallId?: string): Promise<void> {
    void this.speak(text, toolCallId).catch((error: unknown) => {
      this.logger?.warn(
        { err: error, event: "discord_voice_speak_background_failed", toolCallId },
        "Failed to complete a background voice reply",
      );
    });
    return Promise.resolve();
  }

  private async playReplyAndDrain(text: string, toolCallId?: string): Promise<void> {
    try {
      await this.playReply(text, toolCallId);
    } finally {
      const pendingReply = this.pendingReply;
      this.pendingReply = undefined;
      if (pendingReply && !this.stopped) {
        void this.playReplyAndDrain(pendingReply.text, pendingReply.toolCallId).then(
          pendingReply.resolve,
          pendingReply.reject,
        );
      } else {
        this.replyActive = false;
        pendingReply?.resolve();
      }
    }
  }

  private async playReply(text: string, toolCallId?: string): Promise<void> {
    const speakId = toolCallId ?? randomUUID();
    const audioPlayer = this.audioPlayer;
    if (!audioPlayer || this.stopped) {
      this.logger?.warn(
        { event: "discord_voice_speak_skipped", speakId, toolCallId, stopped: this.stopped },
        "Voice playback is unavailable",
      );
      return;
    }
    const startedAt = performance.now();
    this.logger?.info(
      { event: "discord_voice_tts_started", speakId, toolCallId, textLength: text.length },
      "Synthesizing a voice reply",
    );
    const audio = await this.options.tts.synthesize(text).catch((error: unknown) => {
      this.logger?.warn(
        {
          err: error,
          event: "discord_voice_tts_failed",
          speakId,
          toolCallId,
          durationMs: Math.round(performance.now() - startedAt),
        },
        "Failed to synthesize a voice reply",
      );
      throw error;
    });
    this.logger?.info(
      {
        event: "discord_voice_tts_completed",
        speakId,
        toolCallId,
        durationMs: Math.round(performance.now() - startedAt),
        audioBytes: audio.byteLength,
      },
      "Synthesized a voice reply",
    );
    const synthesisDurationMs = Math.round(performance.now() - startedAt);
    const playbackStartedAt = performance.now();
    let played = false;
    let failed = false;
    try {
      if (this.stopped) return;
      this.logger?.info(
        { event: "discord_voice_speak_playback_started", speakId, toolCallId },
        "Starting playback of the synthesized voice reply",
      );
      played = await this.play(audio);
    } catch (error) {
      failed = true;
      this.logger?.warn(
        { err: error, event: "discord_voice_speak_playback_failed", speakId, toolCallId },
        "Failed to play the voice reply",
      );
      throw error;
    } finally {
      this.logger?.info(
        {
          event: "discord_voice_speak_completed",
          speakId,
          toolCallId,
          durationMs: Math.round(performance.now() - startedAt),
          synthesisDurationMs,
          playbackDurationMs: Math.round(performance.now() - playbackStartedAt),
          played,
          stopped: this.stopped,
          failed,
        },
        "Finished the voice reply playback request",
      );
    }
  }

  private play(audio: Uint8Array): Promise<boolean> {
    const player = this.audioPlayer;
    if (!player || this.stopped) return Promise.resolve(false);
    this.replacePlayback(false);
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = (played: boolean, error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (this.currentPlayback?.finish === finish) this.currentPlayback = undefined;
        if (error) reject(error);
        else resolve(played);
      };
      const timeout = setTimeout(() => {
        if (this.currentPlayback?.finish !== finish) return;
        this.currentPlayback = undefined;
        player.stop(true);
        finish(false, new Error("Voice playback timed out"));
      }, 5 * 60_000);
      this.currentPlayback = { finish };
      try {
        player.play(
          this.options.audioResourceFactory?.(audio) ??
            createAudioResource(Readable.from([Buffer.from(audio)]), {
              inputType: StreamType.Arbitrary,
            }),
        );
      } catch (error) {
        finish(false, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private replacePlayback(played: boolean): void {
    const playback = this.currentPlayback;
    if (!playback) return;
    this.currentPlayback = undefined;
    playback.finish(played);
    this.audioPlayer?.stop(true);
  }
}
