export interface AsrAudioFormat {
  readonly encoding: "pcm_s16le";
  readonly sampleRateHz: 16_000;
  readonly channels: 1;
}

export interface AsrTranscriptUpdate {
  readonly utteranceId: string;
  readonly text: string;
  readonly final: boolean;
}

export interface StreamingAsrSession {
  readonly onTranscript: (handler: (update: AsrTranscriptUpdate) => void) => () => void;
  readonly onError: (handler: (error: Error) => void) => () => void;
  startUtterance(utteranceId: string): void;
  sendAudio(pcm: Uint8Array): void;
  finishUtterance(utteranceId: string): void;
  close(): void;
}

export interface StreamingAsr {
  connect(options: {
    readonly language: string;
    readonly audio: AsrAudioFormat;
  }): Promise<StreamingAsrSession>;
}
