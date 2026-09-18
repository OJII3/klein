export interface LiveVoiceSession {
  start(): Promise<void>;
  pushInputAudio(audio: Buffer): void;
  appendCommentary(content: string, delegationId: string | null): void;
  stop(): void;
}

export interface LiveVoiceSessionFactory {
  create(options: {
    instructions: string;
    onAudioOutput: (audio: Buffer) => void;
    onDelegation: (delegationId: string, transcript: string) => Promise<string>;
  }): LiveVoiceSession;
}
