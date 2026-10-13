export type VoiceTranscriptQueueAction = "discard" | "steer" | "keep" | "merge";

export interface VoiceTranscriptQueueSelector {
  checkPoliticalContent?(text: string, signal: AbortSignal): Promise<boolean>;

  select(
    input: {
      currentTranscript: string;
      queuedTranscripts: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<VoiceTranscriptQueueAction>;
}
