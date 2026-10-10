export type VoiceReaction = "none" | "neutral" | "thinking" | "empathetic";

export interface VoiceReactionSelector {
  select(
    input: {
      text: string;
      recentTranscripts: readonly string[];
      lastReaction?: VoiceReaction;
    },
    signal: AbortSignal,
  ): Promise<VoiceReaction>;
}
