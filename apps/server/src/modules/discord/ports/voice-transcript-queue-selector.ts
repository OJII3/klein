export type VoiceTranscriptQueueAction = "discard" | "steer" | "keep" | "merge";

export interface VoiceTranscriptQueueSelector {
  select(
    input: {
      currentTranscript: string;
      queuedTranscripts: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<VoiceTranscriptQueueAction>;
}
