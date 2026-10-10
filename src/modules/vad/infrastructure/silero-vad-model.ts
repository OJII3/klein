import * as ort from "onnxruntime-web";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import modelPath from "./models/silero_vad_16k_op15.onnx" with { type: "file" };
import type { VadFrameScorer } from "../domain/vad-stream";

export class SileroVadModel implements VadFrameScorer {
  private static sessionPromise?: Promise<ort.InferenceSession>;
  private state = new Float32Array(2 * 128);
  private readonly context = new Float32Array(64);

  private constructor(private readonly session: ort.InferenceSession) {}

  static async create(): Promise<SileroVadModel> {
    const resolvedModelPath = isAbsolute(modelPath)
      ? modelPath
      : resolve(dirname(fileURLToPath(import.meta.url)), modelPath);
    this.sessionPromise ??= ort.InferenceSession.create(resolvedModelPath, {
      executionProviders: ["wasm"],
    });
    let session: ort.InferenceSession;
    try {
      session = await this.sessionPromise;
    } catch (error) {
      this.sessionPromise = undefined;
      throw error;
    }
    return new SileroVadModel(session);
  }

  async score(frame: Float32Array): Promise<number> {
    if (frame.length !== 512) throw new Error("Silero VAD expects 512-sample frames");
    // Silero's streaming input includes the previous frame's last 64 samples.
    const input = new Float32Array(this.context.length + frame.length);
    input.set(this.context);
    input.set(frame, this.context.length);
    const results = await this.session.run({
      input: new ort.Tensor("float32", input, [1, input.length]),
      state: new ort.Tensor("float32", this.state, [2, 1, 128]),
      sr: new ort.Tensor("int64", BigInt64Array.of(16_000n), []),
    });
    const probability = results.output?.data[0];
    const nextState = results.stateN?.data;
    if (typeof probability !== "number" || !(nextState instanceof Float32Array)) {
      throw new Error("Silero VAD returned an invalid result");
    }
    this.state = new Float32Array(nextState);
    this.context.set(frame.subarray(frame.length - this.context.length));
    return probability;
  }

  async close(): Promise<void> {
    this.reset();
  }

  reset(): void {
    this.state.fill(0);
    this.context.fill(0);
  }
}
