export interface ConversationTranscriptMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp: string;
}

export interface ConversationTranscriptReader {
  read(input: {
    readonly sessionKey: string;
    readonly limit: number;
    readonly since?: number;
  }): Promise<readonly ConversationTranscriptMessage[]>;
}
