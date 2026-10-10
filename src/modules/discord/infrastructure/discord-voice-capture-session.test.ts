import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { AsrConnection, AsrRequest } from "@modules/asr/domain/asr-client";

import { DiscordVoiceCaptureSession } from "./discord-voice-capture-session";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createCapture() {
  const results: Deferred<{ readonly text: string }>[] = [];
  const decoders: Array<{ emit(type: string, value?: unknown): boolean }> = [];
  const transcripts: string[] = [];
  const connection: AsrConnection = {
    onError: () => () => undefined,
    start: (): AsrRequest => {
      const result = deferred<{ readonly text: string }>();
      results.push(result);
      return {
        write: () => undefined,
        commit: () => result.promise,
      };
    },
    close: () => undefined,
  };
  const capture = new DiscordVoiceCaptureSession({
    adapterCreator: {} as never,
    asr: { connect: async () => connection },
    guildId: "guild",
    language: "ja",
    onTranscript: async (text) => {
      transcripts.push(text);
    },
    tts: { synthesize: async () => new Uint8Array() },
    userId: "user",
    voiceChannelId: "voice",
  });
  const source = new EventEmitter() as EventEmitter & {
    pipe(decoder: unknown): unknown;
    destroy(): void;
  };
  source.pipe = (decoder) => {
    decoders.push(decoder as (typeof decoders)[number]);
    return decoder;
  };
  source.destroy = () => undefined;
  const receiver = { subscribe: () => source };
  (capture as unknown as { connection: unknown }).connection = {
    receiver,
    destroy: () => undefined,
  };
  (capture as unknown as { asrConnection: AsrConnection }).asrConnection = connection;
  (capture as unknown as { vad: unknown }).vad = {
    push: async (pcm: Uint8Array) => [{ type: "speech-start", pcm }],
    pushSilence: async () => [{ type: "speech-end" }],
    finish: () => [],
  };
  const receive = (capture as unknown as { receiveUtterance(): void }).receiveUtterance.bind(
    capture,
  );
  const startInput = (): void => {
    receive();
  };
  const emitUtterance = async (): Promise<void> => {
    source.emit("data");
    const decoder = decoders.at(-1);
    decoder?.emit("data", Buffer.alloc(1024));
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  return { capture, decoders, emitUtterance, results, startInput, transcripts };
}

test("delivers ASR results in utterance order when inference completes out of order", async () => {
  const { capture, decoders, emitUtterance, results, startInput, transcripts } = createCapture();
  startInput();
  await emitUtterance();
  await emitUtterance();
  results[1]?.resolve({ text: "second" });
  await Promise.resolve();
  assert.deepEqual(transcripts, []);
  results[0]?.resolve({ text: "first" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(transcripts, ["first", "second"]);
  assert.equal(decoders.length, 1);
  await capture.stop();
});

test("continues delivering later results after a request fails", async () => {
  const { capture, emitUtterance, results, startInput, transcripts } = createCapture();
  startInput();
  await emitUtterance();
  await emitUtterance();
  results[0]?.reject(new Error("request failed"));
  results[1]?.resolve({ text: "next utterance" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(transcripts, ["next utterance"]);
  await capture.stop();
});

test("does not deliver queued transcripts after capture stops", async () => {
  const { capture, emitUtterance, results, startInput, transcripts } = createCapture();
  startInput();
  await emitUtterance();
  await capture.stop();
  results[0]?.resolve({ text: "too late" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(transcripts, []);
});
