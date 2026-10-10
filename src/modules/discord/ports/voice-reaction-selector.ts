export interface VoiceReactionPreset {
  readonly id: string;
  readonly text: string;
  readonly description: string;
  readonly audioFile: string;
}

export interface VoiceReactionSelector {
  select(
    input: {
      text: string;
      recentTranscripts: readonly string[];
      lastReaction?: string;
    },
    signal: AbortSignal,
  ): Promise<string | undefined>;
}
