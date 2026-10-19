import assert from "node:assert/strict";
import test from "node:test";
import type { Logger } from "pino";

import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import { VoiceTranscriptQueue } from "./voice-transcript-queue";

function createMessage(id: string, content: string): DiscordMessage {
  return {
    occurredAt: new Date(0).toISOString(),
    author: { bot: false, displayName: "Satsuki", id: "user-1", username: "satsuki" },
    channelId: "channel-1",
    content,
    guildId: "guild-1",
    id,
    images: [],
  };
}

function createLogger(info: (...args: unknown[]) => void = () => undefined): Logger {
  return { info } as unknown as Logger;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("merges adjacent queued transcripts before continuing processing", async () => {
  let processing = true;
  let queue!: VoiceTranscriptQueue;
  const processed = deferred<DiscordMessage>();
  queue = new VoiceTranscriptQueue({
    selector: { select: async () => "merge" },
    logger: createLogger((data) => {
      if ((data as { event?: string }).event === "voice_chat_transcripts_merged") {
        processing = false;
      }
    }),
    isStopped: () => false,
    isProcessing: () => processing,
    currentTranscript: () => "active transcript",
    processNext: () => processed.resolve(queue.takeNext()!),
  });
  queue.enqueue(createMessage("first", "hello"));
  queue.enqueue(createMessage("second", "there"));

  queue.scheduleDecision();

  assert.deepEqual(await processed.promise, createMessage("first", "hello\nthere"));
  assert.equal(queue.hasPending, false);
  queue.stop();
});

test("steers the active response with the first queued transcript", async () => {
  const steered = deferred<DiscordMessage>();
  const queue = new VoiceTranscriptQueue({
    selector: { select: async () => "steer" },
    logger: createLogger(),
    isStopped: () => false,
    isProcessing: () => true,
    currentTranscript: () => "active transcript",
    processNext: () => assert.fail("steer should not start another prompt"),
    steer: async (message) => steered.resolve(message),
  });
  const message = createMessage("next", "interrupting transcript");
  queue.enqueue(message);

  queue.scheduleDecision();

  assert.deepEqual(await steered.promise, message);
  assert.equal(queue.hasPending, false);
  queue.stop();
});
