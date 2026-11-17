export interface VadFrameScorer {
  score(frame: Float32Array): Promise<number>;
  reset?(): void;
}
