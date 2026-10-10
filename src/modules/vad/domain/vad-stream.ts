export interface VadFrameScorer {
  score(frame: Float32Array): Promise<number>;
  reset?(): void;
}

export type VadEvent =
  | { readonly type: "speech-start"; readonly pcm: Uint8Array }
  | { readonly type: "audio"; readonly pcm: Uint8Array }
  | { readonly type: "speech-end" };

const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 512;
const FRAME_BYTES = FRAME_SAMPLES * 2;
const SPEECH_THRESHOLD = 0.5;
const END_SILENCE_FRAMES = 16;
const PRE_ROLL_FRAMES = 7;

export class VadStream {
  private remainder = new Uint8Array();
  private readonly preRoll: Uint8Array[] = [];
  private speechActive = false;
  private silenceFrames = 0;

  constructor(private readonly scorer: VadFrameScorer) {}

  async push(pcm: Uint8Array): Promise<VadEvent[]> {
    if (pcm.byteLength % 2 !== 0) throw new Error("VAD audio must contain whole PCM samples");
    const joined = new Uint8Array(this.remainder.byteLength + pcm.byteLength);
    joined.set(this.remainder);
    joined.set(pcm, this.remainder.byteLength);
    const events: VadEvent[] = [];
    let offset = 0;
    while (offset + FRAME_BYTES <= joined.byteLength) {
      const frame = joined.slice(offset, offset + FRAME_BYTES);
      await this.processFrame(frame, events);
      offset += FRAME_BYTES;
    }
    this.remainder = joined.slice(offset);
    return events;
  }

  async pushSilence(durationMs: number): Promise<VadEvent[]> {
    const samples = Math.ceil((SAMPLE_RATE * durationMs) / 1000);
    return this.push(new Uint8Array(samples * 2));
  }

  finish(): VadEvent[] {
    if (!this.speechActive) return [];
    this.speechActive = false;
    this.silenceFrames = 0;
    this.preRoll.length = 0;
    return [{ type: "speech-end" }];
  }

  reset(): void {
    this.remainder = new Uint8Array();
    this.preRoll.length = 0;
    this.speechActive = false;
    this.silenceFrames = 0;
    this.scorer.reset?.();
  }

  private async processFrame(pcm: Uint8Array, events: VadEvent[]): Promise<void> {
    const samples = new Float32Array(FRAME_SAMPLES);
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let i = 0; i < FRAME_SAMPLES; i += 1) samples[i] = view.getInt16(i * 2, true) / 32768;
    const probability = await this.scorer.score(samples);
    if (this.speechActive) {
      events.push({ type: "audio", pcm });
      if (probability < SPEECH_THRESHOLD) this.silenceFrames += 1;
      else this.silenceFrames = 0;
      if (this.silenceFrames >= END_SILENCE_FRAMES) {
        events.push({ type: "speech-end" });
        this.speechActive = false;
        this.silenceFrames = 0;
        this.preRoll.length = 0;
      }
      return;
    }

    if (probability >= SPEECH_THRESHOLD) {
      const buffered = [...this.preRoll, pcm];
      const speechPcm = new Uint8Array(
        buffered.reduce((size, frame) => size + frame.byteLength, 0),
      );
      let offset = 0;
      for (const frame of buffered) {
        speechPcm.set(frame, offset);
        offset += frame.byteLength;
      }
      events.push({ type: "speech-start", pcm: speechPcm });
      this.speechActive = true;
      this.silenceFrames = 0;
      this.preRoll.length = 0;
      return;
    }

    this.preRoll.push(pcm);
    if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
  }
}
