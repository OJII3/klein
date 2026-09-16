import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pino from "pino";

import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import { TaskCoordinator } from "@app/task-coordinator";
import type { MemoryMessage, MemoryOperation, MemoryProcessor } from "../domain/memory";
import { MemoryCoordinator } from "./memory-coordinator";

test("batches recent guild messages and keeps guild memory files separate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-memory-"));
  const processed: string[][] = [];
  const processor: MemoryProcessor = {
    async process(
      _document,
      messages: readonly MemoryMessage[],
    ): Promise<readonly MemoryOperation[]> {
      processed.push(messages.map((message) => message.id));
      return [
        {
          content: `処理済み: ${messages.map((message) => message.id).join(", ")}`,
          kind: "fact",
          title: "処理結果",
          type: "add",
        },
      ];
    },
  };
  const taskCoordinator = new TaskCoordinator();
  const coordinator = new MemoryCoordinator({
    filePath: join(directory, "{guildId}", "MEMORY.md"),
    idleSeconds: 0.01,
    logger: pino({ level: "silent" }),
    maxBatchAgeSeconds: 1,
    maxBatchMessages: 10,
    processor,
    taskCoordinator,
  });

  try {
    coordinator.enqueue(createMessage("guild-a", "message-a1", "A-1"));
    coordinator.enqueue(createMessage("guild-a", "message-a2", "A-2"));
    coordinator.enqueue(createMessage("guild-b", "message-b1", "B-1"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await taskCoordinator.waitForCompletion();

    assert.deepEqual(processed.sort(), [["message-a1", "message-a2"], ["message-b1"]].sort());
    assert.match((await coordinator.getContext("guild-a")) ?? "", /message-a1/u);
    assert.match((await coordinator.getContext("guild-b")) ?? "", /message-b1/u);
    assert.equal(await coordinator.getContext("guild-c"), undefined);
  } finally {
    coordinator.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

function createMessage(guildId: string, id: string, content: string): DiscordMessage {
  return {
    author: {
      bot: false,
      displayName: "ユーザー",
      id: "user-1",
      username: "user",
    },
    channelId: `${guildId}-channel`,
    content,
    guildId,
    id,
    images: [],
  };
}
