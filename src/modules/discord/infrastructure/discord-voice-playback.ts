import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  type VoiceConnection,
} from "@discordjs/voice";
import type { Logger } from "pino";
import { Readable } from "node:stream";

import type { VoiceReactionPreset } from "@modules/discord/ports/voice-reaction-selector";
import type { TextToSpeech } from "@modules/tts/infrastructure/sbv2-tts";

export interface DiscordVoicePlaybackOptions {
  readonly audioResourceFactory?: (audio: Uint8Array) => ReturnType<typeof createAudioResource>;
  readonly logger?: Logger;
  readonly reactionPresets?: readonly VoiceReactionPreset[];
  readonly tts: TextToSpeech;
}

export class DiscordVoicePlayback {
  private readonly logger?: Logger;
  private audioPlayer?: ReturnType<typeof createAudioPlayer>;
  private stopped = false;
  private replyActive = false;
  private pendingReply?: {
    readonly text: string;
    readonly toolCallId?: string;
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
  };
  private userSpeechActive = false;
  private readonly reactionAudio = new Map<string, Uint8Array>();
  private currentPlayback?: {
    kind: "reply" | "reaction";
    finish: (played: boolean, error?: Error) => void;
  };

  constructor(private readonly options: DiscordVoicePlaybackOptions) {
    this.logger = options.logger?.child({ component: "discord-voice-playback" });
  }

  start(connection: VoiceConnection): void {
    this.audioPlayer = createAudioPlayer();
    this.audioPlayer.on("error", (error) => {
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
    this.audioPlayer.on("stateChange", (previous, next) => {
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
    connection.subscribe(this.audioPlayer);
    void this.loadReactionAudio();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pendingReply?.resolve();
    this.pendingReply = undefined;
    this.reactionAudio.clear();
    this.stopReaction();
    const playback = this.currentPlayback;
    this.currentPlayback = undefined;
    playback?.finish(false);
    this.audioPlayer?.stop(true);
    this.audioPlayer = undefined;
  }

  onSpeechStart(): void {
    this.userSpeechActive = true;
    this.stopReaction();
  }

  onSpeechEnd(): void {
    this.userSpeechActive = false;
  }

  async speak(text: string, toolCallId?: string): Promise<void> {
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

  async playReaction(reaction: string, signal: AbortSignal): Promise<boolean> {
    const audio = this.reactionAudio.get(reaction);
    if (
      !audio ||
      signal.aborted ||
      this.stopped ||
      this.userSpeechActive ||
      this.currentPlayback?.kind === "reply"
    )
      return false;
    return this.play(audio, "reaction", signal);
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
    this.stopReaction();
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
      this.stopReaction();
      this.logger?.info(
        { event: "discord_voice_speak_playback_started", speakId, toolCallId },
        "Starting playback of the synthesized voice reply",
      );
      played = await this.play(audio, "reply");
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

  private async loadReactionAudio(): Promise<void> {
    await Promise.all(
      (this.options.reactionPresets ?? []).map(async (preset) => {
        try {
          const audio = await readFile(resolve(preset.audioFile));
          if (!this.stopped) this.reactionAudio.set(preset.id, audio);
        } catch (error) {
          this.logger?.warn(
            {
              err: error,
              event: "discord_voice_reaction_preset_load_failed",
              reaction: preset.id,
              audioFile: preset.audioFile,
            },
            "Failed to load a voice reaction preset audio file",
          );
        }
      }),
    );
  }

  private play(
    audio: Uint8Array,
    kind: "reply" | "reaction",
    signal?: AbortSignal,
  ): Promise<boolean> {
    const player = this.audioPlayer;
    if (!player || this.stopped || signal?.aborted) return Promise.resolve(false);
    this.replacePlayback(false);
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = (played: boolean, error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
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
      const onAbort = (): void => {
        if (this.currentPlayback?.finish !== finish) return;
        this.currentPlayback = undefined;
        player.stop(true);
        finish(false);
      };
      this.currentPlayback = { kind, finish };
      signal?.addEventListener("abort", onAbort, { once: true });
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

  private stopReaction(): void {
    if (this.currentPlayback?.kind === "reaction") this.replacePlayback(false);
  }
}
