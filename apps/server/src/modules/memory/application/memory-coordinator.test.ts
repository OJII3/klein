import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import pino from "pino";

import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import { TaskCoordinator } from "@app/task-coordinator";

import type { GuildMemoryMessage, GuildMemoryScopeState } from "../domain/guild-memory";
import { MarkdownGuildMemoryStore } from "../infrastructure/markdown-guild-memory-store";
import type { MemoryProcessor } from "../ports/memory-processor";
import { MemoryCoordinator } from "./memory-coordinator";
import { createTempDir } from "../../../testing/temp-dir";

test("batches recent guild messages and keeps guild memory files separate", async () => {
  await using temp = await createTempDir("klein-memory-");
  const directory = temp.path;
  const processed: string[][] = [];
  const store = new MarkdownGuildMemoryStore(directory);
  const processor: MemoryProcessor = {
    async process(
      guildId: string,
      _scopes: readonly GuildMemoryScopeState[],
      messages: readonly GuildMemoryMessage[],
    ): Promise<void> {
      processed.push(messages.map((message) => message.id));
      const channelId = messages[0]?.channelId ?? "unknown";
      await store.write(
        guildId,
        { channelId, type: "channel" },
        {
          facts: [`処理済み: ${messages.map((message) => message.id).join(", ")}`],
          preferences: [],
        },
      );
    },
  };
  const taskCoordinator = new TaskCoordinator();
  const coordinator = new MemoryCoordinator({
    store,
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
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });
    await taskCoordinator.waitForCompletion();

    assert.deepEqual(
      processed.toSorted(byFirstId),
      [["message-a1", "message-a2"], ["message-b1"]].toSorted(byFirstId),
    );
    assert.match(
      (await coordinator.getContext({
        channelId: "guild-a-channel",
        guildId: "guild-a",
      })) ?? "",
      /message-a1/u,
    );
    assert.equal(
      await coordinator.getContext({ channelId: "other-channel", guildId: "guild-a" }),
      undefined,
    );
    assert.match(
      (await coordinator.getContext({
        channelId: "guild-b-channel",
        guildId: "guild-b",
      })) ?? "",
      /message-b1/u,
    );
    assert.equal(
      await coordinator.getContext({ channelId: "guild-c-channel", guildId: "guild-c" }),
      undefined,
    );
    assert.deepEqual(
      (await coordinator.listGuilds()).map(({ guildId, itemCount }) => ({ guildId, itemCount })),
      [
        { guildId: "guild-a", itemCount: 1 },
        { guildId: "guild-b", itemCount: 1 },
      ],
    );
  } finally {
    coordinator.dispose();
  }
});

test("flushes pending guild memory when asked", async () => {
  await using temp = await createTempDir("klein-memory-");
  const processed: string[][] = [];
  const processor: MemoryProcessor = {
    async process(
      _guildId: string,
      _scopes: readonly GuildMemoryScopeState[],
      messages: readonly GuildMemoryMessage[],
    ): Promise<void> {
      processed.push(messages.map((message) => message.id));
    },
  };
  const taskCoordinator = new TaskCoordinator();
  const coordinator = new MemoryCoordinator({
    store: new MarkdownGuildMemoryStore(join(temp.path, "memory")),
    idleSeconds: 60,
    logger: pino({ level: "silent" }),
    maxBatchAgeSeconds: 60,
    maxBatchMessages: 10,
    processor,
    taskCoordinator,
  });

  try {
    coordinator.enqueue(createMessage("guild-a", "message-a1", "A-1"));
    await coordinator.flush();
    assert.deepEqual(processed, [["message-a1"]]);
  } finally {
    coordinator.dispose();
  }
});

test("passes guild, channel, and thread memory to the processor", async () => {
  await using temp = await createTempDir("klein-memory-");
  const store = new MarkdownGuildMemoryStore(temp.path);
  await store.write("guild-a", { type: "guild" }, { facts: ["ギルド"], preferences: [] });
  await store.write(
    "guild-a",
    { channelId: "channel-1", type: "channel" },
    {
      facts: ["チャンネル"],
      preferences: [],
    },
  );
  await store.write(
    "guild-a",
    { channelId: "channel-1", threadId: "thread-1", type: "thread" },
    {
      facts: ["スレッド"],
      preferences: [],
    },
  );

  let received: readonly GuildMemoryScopeState[] = [];
  const processor: MemoryProcessor = {
    async process(_guildId, scopes): Promise<void> {
      received = scopes;
    },
  };
  const taskCoordinator = new TaskCoordinator();
  const coordinator = new MemoryCoordinator({
    store,
    idleSeconds: 1,
    logger: pino({ level: "silent" }),
    maxBatchAgeSeconds: 1,
    maxBatchMessages: 10,
    processor,
    taskCoordinator,
  });

  try {
    coordinator.enqueue({
      ...createMessage("guild-a", "message-a1", "スレッド内"),
      channelId: "thread-1",
      parentChannelId: "channel-1",
      threadId: "thread-1",
    });
    await coordinator.flush();

    const context = await coordinator.getContext({
      channelId: "channel-1",
      guildId: "guild-a",
      threadId: "thread-1",
    });
    assert.match(context ?? "", /## Guild\n\n### Facts\n\n- ギルド/u);
    assert.match(context ?? "", /## Channel \(channel-1\)\n\n### Facts\n\n- チャンネル/u);
    assert.match(
      context ?? "",
      /## Thread \(thread-1, channel channel-1\)\n\n### Facts\n\n- スレッド/u,
    );

    assert.deepEqual(
      received.map(({ memory, scope }) => ({ memory, scope })),
      [
        { memory: { facts: ["ギルド"], preferences: [] }, scope: { type: "guild" } },
        {
          memory: { facts: ["チャンネル"], preferences: [] },
          scope: { channelId: "channel-1", type: "channel" },
        },
        {
          memory: { facts: ["スレッド"], preferences: [] },
          scope: { channelId: "channel-1", threadId: "thread-1", type: "thread" },
        },
      ],
    );
  } finally {
    coordinator.dispose();
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
    occurredAt: "2026-10-14T09:30:42.123Z",
    images: [],
  };
}

function byFirstId(left: readonly string[], right: readonly string[]): number {
  return (left[0] ?? "").localeCompare(right[0] ?? "");
}
