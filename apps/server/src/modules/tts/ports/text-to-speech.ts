export interface TextToSpeech {
  synthesize(text: string): Promise<Uint8Array>;
}
