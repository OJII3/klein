import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { setImmediate as waitImmediate } from "node:timers/promises";
import {
  AudioPlayerStatus,
  createAudioResource,
  StreamType,
  type AudioResource,
  type DiscordGatewayAdapterCreator,
} from "@discordjs/voice";

import type { AsrConnection, AsrRequest } from "@modules/asr/domain/asr-client";
import type { VoiceReactionPreset } from "@modules/discord/ports/voice-reaction-selector";
import type { VadEvent } from "@modules/vad/domain/vad-stream";
import { createTempDir } from "../../../testing/temp-dir";
import {
  DiscordVoiceCaptureSession,
  type VoiceActivityDetector,
  type VoiceAudioDecoder,
  type VoiceCaptureConnection,
  type VoiceReceivedAudioStream,
} from "./discord-voice-capture-session";
import type { VoiceAudioPlayer, VoiceLogger } from "./discord-voice-playback";

function createStubAudioResource(): AudioResource {
  return createAudioResource(Readable.from([Buffer.alloc(0)]), { inputType: StreamType.Opus });
}

const adapterCreator: DiscordGatewayAdapterCreator = () => ({
  sendPayload: () => true,
  destroy: () => undefined,
});

class FakeAudioSource extends EventEmitter implements VoiceReceivedAudioStream {
  constructor(private readonly onPipe: (decoder: VoiceAudioDecoder) => void) {
    super();
  }

  pipe(destination: VoiceAudioDecoder): VoiceAudioDecoder {
    this.onPipe(destination);
    return destination;
  }

  destroy(): void {}
}

class FakeAudioDecoder extends PassThrough implements VoiceAudioDecoder {
  override destroy(): this {
    return this;
  }
}

class FakeAudioPlayer extends EventEmitter implements VoiceAudioPlayer {
  readonly played: AudioResource[] = [];
  stopCalls = 0;

  constructor(private readonly onPlay?: (resource: AudioResource) => void) {
    super();
  }

  play(resource: AudioResource): void {
    this.played.push(resource);
    this.onPlay?.(resource);
  }

  stop(): boolean {
    this.stopCalls += 1;
    return true;
  }
}

interface CreateCaptureOptions {
  readonly reactionPresets?: readonly VoiceReactionPreset[];
  readonly synthesize?: (text: string) => Promise<Uint8Array>;
  readonly audioResourceFactory?: (audio: Uint8Array) => AudioResource;
  readonly onPlay?: (resource: AudioResource) => void;
}

function createCapture(testOptions: CreateCaptureOptions = {}) {
  const logs: Array<Record<string, unknown>> = [];
  const logger: VoiceLogger = {
    child: () => logger,
    info: (fields) => {
      logs.push(fields);
    },
    warn: (fields) => {
      logs.push(fields);
    },
    error: (fields) => {
      logs.push(fields);
    },
  };
  const requestIds: string[] = [];
  const deliveredRequestIds: Array<string | undefined> = [];
  const results: PromiseWithResolvers<{ readonly text: string }>[] = [];
  const decoders: FakeAudioDecoder[] = [];
  const transcripts: string[] = [];
  let nextVadEvents: readonly VadEvent[] = [];

  const asrConnection: AsrConnection = {
    onError: () => () => undefined,
    start: ({ requestId }): AsrRequest => {
      requestIds.push(requestId);
      const result = Promise.withResolvers<{ readonly text: string }>();
      results.push(result);
      return {
        write: () => undefined,
        commit: () => result.promise,
      };
    },
    close: () => undefined,
  };

  const speaking = new EventEmitter();
  const source = new FakeAudioSource(() => undefined);
  const connection: VoiceCaptureConnection = {
    destroy: () => undefined,
    subscribePlayer: () => undefined,
    receiver: {
      speaking,
      subscribe: () => source,
    },
  };
  const audioPlayer = new FakeAudioPlayer(testOptions.onPlay);
  const vad: VoiceActivityDetector = {
    push: async (pcm) => {
      if (nextVadEvents.length > 0) {
        const events = nextVadEvents;
        nextVadEvents = [];
        return events;
      }
      return [{ type: "speech-start", pcm }];
    },
    pushSilence: async () => [],
    finish: () => [],
    reset: () => undefined,
  };

  const capture = new DiscordVoiceCaptureSession({
    adapterCreator,
    asr: { connect: async () => asrConnection },
    audioPlayerFactory: () => audioPlayer,
    audioResourceFactory: testOptions.audioResourceFactory ?? (() => createStubAudioResource()),
    connectVoice: async () => connection,
    createDecoder: () => {
      const decoder = new FakeAudioDecoder();
      decoders.push(decoder);
      return decoder;
    },
    createVad: async () => vad,
    guildId: "guild",
    language: "ja",
    logger,
    onTranscript: async (text, requestId) => {
      transcripts.push(text);
      deliveredRequestIds.push(requestId);
    },
    reactionPresets: testOptions.reactionPresets,
    tts: {
      synthesize: testOptions.synthesize ?? (async () => new Uint8Array()),
    },
    userId: "user",
    voiceChannelId: "voice",
  });

  const startInput = (): void => {
    speaking.emit("start", "user");
  };

  const emitVadEvents = async (events: readonly VadEvent[]): Promise<void> => {
    nextVadEvents = events;
    source.emit("data");
    const decoder = decoders.at(-1);
    decoder?.emit("data", Buffer.alloc(1024));
    await capture.flushInput();
  };

  const emitUtterance = async (): Promise<void> => {
    await emitVadEvents([{ type: "speech-start", pcm: new Uint8Array([1, 2]) }]);
    await emitVadEvents([{ type: "speech-end" }]);
  };

  return {
    audioPlayer,
    logs,
    requestIds,
    deliveredRequestIds,
    capture,
    decoders,
    emitUtterance,
    emitVadEvents,
    results,
    startInput,
    transcripts,
  };
}

async function createPreset(
  directory: string,
  id: string,
  audio: Uint8Array = new Uint8Array([1]),
): Promise<VoiceReactionPreset> {
  const audioFile = join(directory, `${id}.pcm`);
  await writeFile(audioFile, audio);
  return { id, text: id, description: id, audioFile };
}

test("delivers ASR results in utterance order when inference completes out of order", async () => {
  const { capture, decoders, emitUtterance, results, startInput, transcripts } = createCapture();
  await capture.start();
  startInput();
  await emitUtterance();
  await emitUtterance();
  results[1]?.resolve({ text: "second" });
  await Promise.resolve();
  assert.deepEqual(transcripts, []);
  results[0]?.resolve({ text: "first" });
  await capture.flush();
  assert.deepEqual(transcripts, ["first", "second"]);
  assert.equal(decoders.length, 1);
  await capture.stop();
});

test("continues delivering later results after a request fails", async () => {
  const { capture, emitUtterance, results, startInput, transcripts } = createCapture();
  await capture.start();
  startInput();
  await emitUtterance();
  await emitUtterance();
  results[0]?.reject(new Error("request failed"));
  results[1]?.resolve({ text: "next utterance" });
  await capture.flush();
  assert.deepEqual(transcripts, ["next utterance"]);
  await capture.stop();
});

test("does not deliver queued transcripts after capture stops", async () => {
  const { capture, emitUtterance, results, startInput, transcripts } = createCapture();
  await capture.start();
  startInput();
  await emitUtterance();
  await capture.stop();
  results[0]?.resolve({ text: "too late" });
  await capture.flush();
  assert.deepEqual(transcripts, []);
});

test("aborting a preset reaction stops only that playback", async () => {
  await using temp = await createTempDir("klein-reaction-");
  const { audioPlayer, capture } = createCapture({
    reactionPresets: [await createPreset(temp.path, "neutral")],
  });
  await capture.start();
  await capture.waitForReactionsLoaded();
  const controller = new AbortController();
  const playback = capture.playReaction("neutral", controller.signal);
  assert.equal(audioPlayer.played.length, 1);
  controller.abort();
  assert.equal(await playback, false);
  assert.equal(audioPlayer.stopCalls, 1);
  await capture.stop();
});

test("a ready reply preempts a reaction without allowing its stale completion to stop the reply", async () => {
  await using temp = await createTempDir("klein-reaction-");
  const synthesis = Promise.withResolvers<Uint8Array>();
  const { audioPlayer, capture } = createCapture({
    reactionPresets: [await createPreset(temp.path, "thinking")],
    synthesize: () => synthesis.promise,
  });
  await capture.start();
  await capture.waitForReactionsLoaded();
  const reactionController = new AbortController();
  const reaction = capture.playReaction("thinking", reactionController.signal);
  const reply = capture.speak("回答");
  synthesis.resolve(new Uint8Array([2]));
  await waitImmediate();
  assert.equal(await reaction, false);
  assert.equal(audioPlayer.played.length, 2);
  assert.equal(audioPlayer.stopCalls, 1);
  audioPlayer.emit(
    "stateChange",
    { status: AudioPlayerStatus.Playing },
    { status: AudioPlayerStatus.Idle },
  );
  reactionController.abort();
  await reply;
  assert.equal(audioPlayer.stopCalls, 1);
  await capture.stop();
});

test("speech start cancels a playing reaction and suppresses reactions during speech", async () => {
  await using temp = await createTempDir("klein-reaction-");
  const { audioPlayer, capture, emitVadEvents, startInput } = createCapture({
    reactionPresets: [await createPreset(temp.path, "neutral")],
  });
  await capture.start();
  await capture.waitForReactionsLoaded();
  startInput();
  const reaction = capture.playReaction("neutral", new AbortController().signal);
  await emitVadEvents([{ type: "speech-start", pcm: new Uint8Array([1]) }]);
  assert.equal(await reaction, false);
  assert.equal(audioPlayer.stopCalls, 1);
  assert.equal(await capture.playReaction("neutral", new AbortController().signal), false);
  await capture.stop();
});

test("resource creation failure clears playback state for a later reaction", async () => {
  await using temp = await createTempDir("klein-reaction-");
  let shouldFailResource = true;
  const { audioPlayer, capture } = createCapture({
    reactionPresets: [await createPreset(temp.path, "neutral")],
    audioResourceFactory: () => {
      if (shouldFailResource) {
        throw new Error("resource creation failed");
      }
      return createStubAudioResource();
    },
  });
  await capture.start();
  await capture.waitForReactionsLoaded();
  await assert.rejects(
    capture.playReaction("neutral", new AbortController().signal),
    /resource creation failed/,
  );
  assert.equal(audioPlayer.played.length, 0);
  shouldFailResource = false;
  const controller = new AbortController();
  const playback = capture.playReaction("neutral", controller.signal);
  assert.equal(audioPlayer.played.length, 1);
  controller.abort();
  assert.equal(await playback, false);
  await capture.stop();
});

test("loads saved reaction audio without synthesizing it", async () => {
  await using temp = await createTempDir("klein-reaction-");
  const directory = temp.path;
  const expectedAudio = new Uint8Array([4, 5, 6]);
  const neutralPreset = await createPreset(directory, "neutral", expectedAudio);
  let synthesizeCalls = 0;
  let resourceAudio: Uint8Array | undefined;
  const { capture } = createCapture({
    reactionPresets: [
      neutralPreset,
      {
        id: "missing",
        text: "missing",
        description: "missing file",
        audioFile: join(directory, "missing.pcm"),
      },
    ],
    synthesize: async () => {
      synthesizeCalls += 1;
      return new Uint8Array();
    },
    audioResourceFactory: (audio) => {
      resourceAudio = audio;
      return createStubAudioResource();
    },
  });

  try {
    await capture.start();
    await capture.waitForReactionsLoaded();
    const controller = new AbortController();
    const playback = capture.playReaction("neutral", controller.signal);
    assert.deepEqual(Array.from(resourceAudio ?? []), Array.from(expectedAudio));
    assert.equal(synthesizeCalls, 0);
    controller.abort();
    assert.equal(await playback, false);
    assert.equal(await capture.playReaction("missing", new AbortController().signal), false);
    assert.equal(synthesizeCalls, 0);
  } finally {
    await capture.stop();
  }
});

test("traces out-of-order ASR results through ordered transcript delivery without logging text", async () => {
  const fixture = createCapture();
  await fixture.capture.start();
  fixture.startInput();
  await fixture.emitUtterance();
  await fixture.emitUtterance();
  fixture.results[1]?.resolve({ text: "private second transcript" });
  await waitImmediate();
  assert.equal(
    fixture.logs.some((log) => log.event === "discord_voice_transcript_delivery_started"),
    false,
  );
  fixture.results[0]?.resolve({ text: "private first transcript" });
  await fixture.capture.flush();
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
  const played = Promise.withResolvers<void>();
  const { capture, logs } = createCapture({
    onPlay: () => {
      played.resolve();
    },
  });
  await capture.start();
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
