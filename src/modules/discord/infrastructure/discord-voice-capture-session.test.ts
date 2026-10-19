import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Logger } from "pino";
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
  const logs: Array<Record<string, unknown>> = [];
  const logger = {
    child: () => logger,
    info: (fields: Record<string, unknown>) => logs.push(fields),
    warn: (fields: Record<string, unknown>) => logs.push(fields),
    error: (fields: Record<string, unknown>) => logs.push(fields),
  };
  const requestIds: string[] = [];
  const deliveredRequestIds: Array<string | undefined> = [];
  const results: Deferred<{ readonly text: string }>[] = [];
  const decoders: Array<{ emit(type: string, value?: unknown): boolean }> = [];
  const transcripts: string[] = [];
  const connection: AsrConnection = {
    onError: () => () => undefined,
    start: ({ requestId }): AsrRequest => {
      requestIds.push(requestId);
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
    logger: logger as unknown as Logger,
    onTranscript: async (text, requestId) => {
      transcripts.push(text);
      deliveredRequestIds.push(requestId);
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
    logs,
    requestIds,
    deliveredRequestIds,
    capture,
    decoders,
    emitUtterance,
    results,
    startInput,
    transcripts,
    waitForTranscriptQueue,
  };
}

interface PlaybackTestAccess {
  audioPlayer?: unknown;
  readonly reactionAudio: Map<string, Uint8Array>;
  currentPlayback?: { finish(played: boolean): void };
  readonly options: {
    audioResourceFactory?: (audio: Uint8Array) => unknown;
    reactionPresets?: readonly {
      id: string;
      text: string;
      description: string;
      audioFile: string;
    }[];
    tts: { synthesize(text: string): Promise<Uint8Array> };
  };
  loadReactionAudio(): Promise<void>;
}

function playbackOf(capture: DiscordVoiceCaptureSession): PlaybackTestAccess {
  return (capture as unknown as { playback: PlaybackTestAccess }).playback;
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
  playbackOf(capture).audioPlayer = {
    play: (resource: unknown) => played.push(resource),
    stop: () => {
      stopCalls += 1;
    },
  };
  playbackOf(capture).reactionAudio.set("neutral", new Uint8Array([1]));
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
  playbackOf(capture).options.tts = {
    synthesize: () => synthesis.promise,
  };
  let stopCalls = 0;
  const played: unknown[] = [];
  playbackOf(capture).audioPlayer = {
    play: (resource: unknown) => played.push(resource),
    stop: () => {
      stopCalls += 1;
    },
  };
  playbackOf(capture).reactionAudio.set("thinking", new Uint8Array([1]));
  const reactionController = new AbortController();
  const reaction = capture.playReaction("thinking", reactionController.signal);
  const reply = capture.speak("回答");
  synthesis.resolve(new Uint8Array([2]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await reaction, false);
  assert.equal(played.length, 2);
  assert.equal(stopCalls, 1);
  const current = playbackOf(capture).currentPlayback;
  assert.ok(current);
  current.finish(true);
  reactionController.abort();
  await reply;
  assert.equal(stopCalls, 1);
  await capture.stop();
});

test("speech start cancels a playing reaction and suppresses reactions during speech", async () => {
  const { capture } = createCapture();
  let stopCalls = 0;
  playbackOf(capture).audioPlayer = {
    play: () => undefined,
    stop: () => {
      stopCalls += 1;
    },
  };
  playbackOf(capture).reactionAudio.set("neutral", new Uint8Array([1]));
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
  playbackOf(capture).audioPlayer = {
    play: () => {
      playCalls += 1;
    },
    stop: () => undefined,
  };
  playbackOf(capture).reactionAudio.set("neutral", new Uint8Array([1]));
  const options = playbackOf(capture).options;
  options.audioResourceFactory = () => {
    throw new Error("resource creation failed");
  };
  await assert.rejects(
    capture.playReaction("neutral", new AbortController().signal),
    /resource creation failed/,
  );
  assert.equal(playbackOf(capture).currentPlayback, undefined);
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
  const options = playbackOf(capture).options;
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
  playbackOf(capture).audioPlayer = {
    play: () => undefined,
    stop: () => undefined,
  };

  try {
    await playbackOf(capture).loadReactionAudio();
    const controller = new AbortController();
    const playback = capture.playReaction("neutral", controller.signal);
    assert.deepEqual(Array.from(resourceAudio ?? []), Array.from(expectedAudio));
    assert.equal(synthesizeCalls, 0);
    controller.abort();
    assert.equal(await playback, false);
    assert.equal(playbackOf(capture).reactionAudio.has("missing"), false);
  } finally {
    await capture.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("traces out-of-order ASR results through ordered transcript delivery without logging text", async () => {
  const fixture = createCapture();
  fixture.startInput();
  await fixture.emitUtterance();
  await fixture.emitUtterance();
  fixture.results[1]?.resolve({ text: "private second transcript" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    fixture.logs.some((log) => log.event === "discord_voice_transcript_delivery_started"),
    false,
  );
  fixture.results[0]?.resolve({ text: "private first transcript" });
  await fixture.waitForTranscriptQueue();
  assert.deepEqual(fixture.deliveredRequestIds, fixture.requestIds);
  for (const requestId of fixture.requestIds) {
    const related = fixture.logs.filter((log) => log.requestId === requestId);
    assert.ok(related.some((log) => log.event === "discord_voice_asr_completed"));
    const delivery = related.find(
      (log) => log.event === "discord_voice_transcript_delivery_started",
    );
    assert.ok(delivery);
    assert.equal(typeof delivery.asrResultWaitMs, "number");
    assert.equal(typeof delivery.resultQueueWaitMs, "number");
    assert.ok(
      related.some(
        (log) =>
          log.event === "discord_voice_transcript_delivery_completed" && log.failed === false,
      ),
    );
  }
  assert.equal(JSON.stringify(fixture.logs).includes("private"), false);
  await fixture.capture.stop();
});

test("distinguishes synthesis completion from playback interrupted by session stop", async () => {
  const { capture, logs } = createCapture();
  const played = deferred<void>();
  playbackOf(capture).audioPlayer = {
    play: () => played.resolve(),
    stop: () => undefined,
  };
  const reply = capture.speak("private reply text", "speak-tool-call-123");
  await played.promise;
  assert.equal(
    logs.some((log) => log.event === "discord_voice_speak_completed"),
    false,
  );
  await capture.stop();
  await reply;
  const completion = logs.find((log) => log.event === "discord_voice_speak_completed");
  assert.ok(completion);
  assert.equal(completion.speakId, "speak-tool-call-123");
  assert.equal(completion.toolCallId, "speak-tool-call-123");
  assert.equal(completion.played, false);
  assert.equal(completion.stopped, true);
  assert.equal(typeof completion.synthesisDurationMs, "number");
  assert.equal(typeof completion.playbackDurationMs, "number");
  for (const event of [
    "discord_voice_tts_started",
    "discord_voice_tts_completed",
    "discord_voice_speak_playback_started",
  ]) {
    assert.equal(logs.find((log) => log.event === event)?.speakId, completion.speakId);
  }
  assert.equal(JSON.stringify(logs).includes("private reply text"), false);
});
