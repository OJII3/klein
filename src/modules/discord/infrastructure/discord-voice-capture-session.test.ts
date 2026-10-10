import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    audioResourceFactory: () => ({}) as never,
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
    const input = (
      capture as unknown as {
        activeInput?: {
          processing: Promise<void>;
          silenceTimer: ReturnType<typeof setInterval>;
        };
      }
    ).activeInput;
    assert.ok(input);
    clearInterval(input.silenceTimer);
    await input.processing;
    const handleVadEvents = (
      capture as unknown as {
        handleVadEvents(events: readonly unknown[], connection: AsrConnection): Promise<void>;
      }
    ).handleVadEvents.bind(capture);
    await handleVadEvents([{ type: "speech-end" }], connection);
  };
  const waitForTranscriptQueue = async (): Promise<void> => {
    await (capture as unknown as { transcriptQueue: Promise<void> }).transcriptQueue;
  };
  return {
    capture,
    decoders,
    emitUtterance,
    results,
    startInput,
    transcripts,
    waitForTranscriptQueue,
  };
}

test("delivers ASR results in utterance order when inference completes out of order", async () => {
  const {
    capture,
    decoders,
    emitUtterance,
    results,
    startInput,
    transcripts,
    waitForTranscriptQueue,
  } = createCapture();
  startInput();
  await emitUtterance();
  await emitUtterance();
  results[1]?.resolve({ text: "second" });
  await Promise.resolve();
  assert.deepEqual(transcripts, []);
  results[0]?.resolve({ text: "first" });
  await waitForTranscriptQueue();
  assert.deepEqual(transcripts, ["first", "second"]);
  assert.equal(decoders.length, 1);
  await capture.stop();
});

test("continues delivering later results after a request fails", async () => {
  const { capture, emitUtterance, results, startInput, transcripts, waitForTranscriptQueue } =
    createCapture();
  startInput();
  await emitUtterance();
  await emitUtterance();
  results[0]?.reject(new Error("request failed"));
  results[1]?.resolve({ text: "next utterance" });
  await waitForTranscriptQueue();
  assert.deepEqual(transcripts, ["next utterance"]);
  await capture.stop();
});

test("does not deliver queued transcripts after capture stops", async () => {
  const { capture, emitUtterance, results, startInput, transcripts, waitForTranscriptQueue } =
    createCapture();
  startInput();
  await emitUtterance();
  await capture.stop();
  results[0]?.resolve({ text: "too late" });
  await waitForTranscriptQueue();
  assert.deepEqual(transcripts, []);
});

test("aborting a preset reaction stops only that playback", async () => {
  const { capture } = createCapture();
  let stopCalls = 0;
  const played: unknown[] = [];
  (capture as unknown as { audioPlayer: unknown }).audioPlayer = {
    play: (resource: unknown) => played.push(resource),
    stop: () => {
      stopCalls += 1;
    },
  };
  (capture as unknown as { reactionAudio: Map<string, Uint8Array> }).reactionAudio.set(
    "neutral",
    new Uint8Array([1]),
  );
  const controller = new AbortController();
  const playback = capture.playReaction("neutral", controller.signal);
  assert.equal(played.length, 1);
  controller.abort();
  assert.equal(await playback, false);
  assert.equal(stopCalls, 1);
  await capture.stop();
});

test("a ready reply preempts a reaction without allowing its stale completion to stop the reply", async () => {
  const synthesis = deferred<Uint8Array>();
  const { capture } = createCapture();
  (
    capture as unknown as { options: { tts: { synthesize(text: string): Promise<Uint8Array> } } }
  ).options.tts = {
    synthesize: () => synthesis.promise,
  };
  let stopCalls = 0;
  const played: unknown[] = [];
  (capture as unknown as { audioPlayer: unknown }).audioPlayer = {
    play: (resource: unknown) => played.push(resource),
    stop: () => {
      stopCalls += 1;
    },
  };
  (capture as unknown as { reactionAudio: Map<string, Uint8Array> }).reactionAudio.set(
    "thinking",
    new Uint8Array([1]),
  );
  const reactionController = new AbortController();
  const reaction = capture.playReaction("thinking", reactionController.signal);
  const reply = capture.speak("回答");
  synthesis.resolve(new Uint8Array([2]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await reaction, false);
  assert.equal(played.length, 2);
  assert.equal(stopCalls, 1);
  const current = (
    capture as unknown as {
      currentPlayback: { finish(played: boolean): void };
    }
  ).currentPlayback;
  current.finish(true);
  reactionController.abort();
  await reply;
  assert.equal(stopCalls, 1);
  await capture.stop();
});

test("speech start cancels a playing reaction and suppresses reactions during speech", async () => {
  const { capture } = createCapture();
  let stopCalls = 0;
  (capture as unknown as { audioPlayer: unknown }).audioPlayer = {
    play: () => undefined,
    stop: () => {
      stopCalls += 1;
    },
  };
  (capture as unknown as { reactionAudio: Map<string, Uint8Array> }).reactionAudio.set(
    "neutral",
    new Uint8Array([1]),
  );
  const reaction = capture.playReaction("neutral", new AbortController().signal);
  const onSpeechStart = (
    capture as unknown as {
      handleVadEvents(
        events: readonly { type: "speech-start"; pcm: Uint8Array }[],
        connection: AsrConnection,
      ): Promise<void>;
    }
  ).handleVadEvents.bind(capture);
  await onSpeechStart([{ type: "speech-start", pcm: new Uint8Array([1]) }], {
    onError: () => () => undefined,
    start: () => ({ write: () => undefined, commit: async () => ({ text: "" }) }),
    close: () => undefined,
  });
  assert.equal(await reaction, false);
  assert.equal(stopCalls, 1);
  assert.equal(await capture.playReaction("neutral", new AbortController().signal), false);
  await capture.stop();
});

test("resource creation failure clears playback state for a later reaction", async () => {
  const { capture } = createCapture();
  let playCalls = 0;
  (capture as unknown as { audioPlayer: unknown }).audioPlayer = {
    play: () => {
      playCalls += 1;
    },
    stop: () => undefined,
  };
  (capture as unknown as { reactionAudio: Map<string, Uint8Array> }).reactionAudio.set(
    "neutral",
    new Uint8Array([1]),
  );
  const options = (
    capture as unknown as {
      options: { audioResourceFactory: (audio: Uint8Array) => unknown };
    }
  ).options;
  options.audioResourceFactory = () => {
    throw new Error("resource creation failed");
  };
  await assert.rejects(
    capture.playReaction("neutral", new AbortController().signal),
    /resource creation failed/,
  );
  assert.equal((capture as unknown as { currentPlayback?: unknown }).currentPlayback, undefined);
  options.audioResourceFactory = () => ({});
  const controller = new AbortController();
  const playback = capture.playReaction("neutral", controller.signal);
  assert.equal(playCalls, 1);
  controller.abort();
  assert.equal(await playback, false);
  await capture.stop();
});

test("loads saved reaction audio without synthesizing it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-reaction-"));
  const audioFile = join(directory, "neutral.pcm");
  const expectedAudio = new Uint8Array([4, 5, 6]);
  await writeFile(audioFile, expectedAudio);
  const { capture } = createCapture();
  let synthesizeCalls = 0;
  let resourceAudio: Uint8Array | undefined;
  const options = (
    capture as unknown as {
      options: {
        reactionPresets: readonly {
          id: string;
          text: string;
          description: string;
          audioFile: string;
        }[];
        tts: { synthesize(text: string): Promise<Uint8Array> };
        audioResourceFactory(audio: Uint8Array): unknown;
      };
    }
  ).options;
  options.reactionPresets = [
    { id: "neutral", text: "うん", description: "相槌", audioFile },
    {
      id: "missing",
      text: "missing",
      description: "missing file",
      audioFile: join(directory, "missing.pcm"),
    },
  ];
  options.tts = {
    synthesize: async () => {
      synthesizeCalls += 1;
      return new Uint8Array();
    },
  };
  options.audioResourceFactory = (audio) => {
    resourceAudio = audio;
    return {};
  };
  (capture as unknown as { audioPlayer: unknown }).audioPlayer = {
    play: () => undefined,
    stop: () => undefined,
  };

  try {
    await (capture as unknown as { loadReactionAudio(): Promise<void> }).loadReactionAudio();
    const controller = new AbortController();
    const playback = capture.playReaction("neutral", controller.signal);
    assert.deepEqual(Array.from(resourceAudio ?? []), Array.from(expectedAudio));
    assert.equal(synthesizeCalls, 0);
    controller.abort();
    assert.equal(await playback, false);
    assert.equal(
      (capture as unknown as { reactionAudio: Map<string, Uint8Array> }).reactionAudio.has(
        "missing",
      ),
      false,
    );
  } finally {
    await capture.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
