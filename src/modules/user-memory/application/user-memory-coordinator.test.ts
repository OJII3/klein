import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import pino from "pino";

import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import { TaskCoordinator } from "@app/task-coordinator";

import type {
  UserMemory,
  UserMemoryMessage,
  UserMemoryPatch,
  UserMemoryProcessor,
} from "../domain/user-memory";
import { MarkdownUserMemoryStore } from "../infrastructure/markdown-user-memory-store";
import { UserMemoryCoordinator } from "./user-memory-coordinator";
import { createTempDir } from "../../../testing/temp-dir";

test("creates a memory as soon as a message is observed", async () => {
  await using temp = await createTempDir("klein-user-memory-");
  const store = new MarkdownUserMemoryStore(join(temp.path, "memory"));
  const coordinator = new UserMemoryCoordinator({
    store,
    processor: {
      async process(): Promise<UserMemoryPatch> {
        return {};
      },
    },
    logger: pino({ level: "silent" }),
    taskCoordinator: new TaskCoordinator(),
    idleSeconds: 60,
  });

  try {
    await coordinator.observe(createMessage("100000000000000001", "message-a", "こんにちは"));

    const memory = await store.read("100000000000000001");
    assert.ok(memory);
    assert.equal(memory.discordId, "alice");
    assert.equal(memory.displayName, "Alice");

    await coordinator.observe(createMessage("100000000000000002", "message-b", "こんにちは", true));
    assert.equal(await store.read("100000000000000002"), undefined);
  } finally {
    coordinator.dispose();
  }
});

test("batches messages per user and applies the generated patch", async () => {
  await using temp = await createTempDir("klein-user-memory-");
  const store = new MarkdownUserMemoryStore(join(temp.path, "memory"));
  const processed: { ids: string[]; userId: string }[] = [];
  const processor: UserMemoryProcessor = {
    async process(memory: UserMemory, messages: readonly UserMemoryMessage[]) {
      processed.push({ ids: messages.map((message) => message.id), userId: memory.discordId });
      return {
        facts: `- 好きなもの: ${messages.at(-1)?.content ?? ""}`,
        summary: "TypeScriptが好きなユーザー",
      };
    },
  };
  const taskCoordinator = new TaskCoordinator();
  const coordinator = new UserMemoryCoordinator({
    store,
    processor,
    logger: pino({ level: "silent" }),
    taskCoordinator,
    idleSeconds: 0.01,
    maxBatchAgeSeconds: 1,
    maxBatchMessages: 10,
  });

  try {
    await coordinator.observe(
      createMessage("100000000000000001", "message-a1", "TypeScriptが好き"),
    );
    await coordinator.observe(createMessage("100000000000000001", "message-a2", "普段はBunを使う"));
    await coordinator.observe(
      createMessage("100000000000000002", "message-b1", "Rustが好き", false, "bob"),
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    await taskCoordinator.waitForCompletion();

    assert.deepEqual(
      processed.toSorted((left, right) => left.userId.localeCompare(right.userId)),
      [
        { ids: ["message-a1", "message-a2"], userId: "alice" },
        { ids: ["message-b1"], userId: "bob" },
      ],
    );

    const alice = await store.read("100000000000000001");
    assert.match(alice?.facts ?? "", /普段はBunを使う/u);
    assert.equal(alice?.summary, "TypeScriptが好きなユーザー");
    assert.equal(alice?.history, "なし");

    const bob = await store.read("100000000000000002");
    assert.match(bob?.facts ?? "", /Rustが好き/u);
  } finally {
    coordinator.dispose();
    await taskCoordinator.waitForCompletion();
  }
});

function createMessage(
  userId: string,
  id: string,
  content: string,
  bot = false,
  username = "alice",
): DiscordMessage {
  return {
    author: {
      bot,
      displayName: username === "alice" ? "Alice" : "Bob",
      id: userId,
      username,
    },
    channelId: "channel-1",
    channelName: "雑談",
    content,
    id,
    occurredAt: "2026-11-11T03:00:00.000Z",
    images: [],
  };
}
