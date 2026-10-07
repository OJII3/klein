export interface TextToSpeech {
  synthesize(text: string): Promise<Uint8Array>;
}

export class Sbv2Tts implements TextToSpeech {
  constructor(private readonly serverUrl: string) {}

  async synthesize(text: string): Promise<Uint8Array> {
    const url = new URL("/voice", this.serverUrl);
    url.searchParams.set("text", text);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`SBV2 returned HTTP ${response.status}: ${await response.text()}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}
