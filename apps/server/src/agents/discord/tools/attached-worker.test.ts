import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryScheduledTaskStore,
  createStubDiscordChannelApi,
  createStubExtensionToolContext,
} from "@agents/testing/test-stubs";
import type { WatchCheckRunner } from "@modules/scheduling/ports/watch-check-runner";
import { createAttachedWorkerTools } from "./attached-worker";

const runner: WatchCheckRunner = {
  async run() {
    return { output: "", decision: "silent", exitCode: 0, durationMs: 0, state: {} };
  },
};

test("gives a worker the read tool and its own watch tools", () => {
  const store = new InMemoryScheduledTaskStore();
  const tools = createAttachedWorkerTools(
    createStubDiscordChannelApi(),
    "channel-a",
    "public",
    "attached-1",
    store,
    runner,
  );

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["discord_read", "watch_add", "watch_update", "watch_list", "watch_get", "watch_delete"],
  );
});

test("registers a worker watch with the worker's task id", async () => {
  const store = new InMemoryScheduledTaskStore();
  const tools = createAttachedWorkerTools(
    createStubDiscordChannelApi(),
    "channel-a",
    "public",
    "attached-1",
    store,
    runner,
  );
  const addTool = tools.find((tool) => tool.name === "watch_add");
  assert.ok(addTool);

  await addTool.execute(
    "tool-call",
    {
      name: "在庫監視",
      schedule: { type: "every", minutes: 5 },
      script: "silent();",
      message: "在庫の変化を確認してください。",
    },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  const watch = store.created[0];
  assert.equal(watch?.kind === "watch" ? watch.ownerTaskId : undefined, "attached-1");
});

test("wires image analysis into the worker's discord_read tool", async () => {
  const store = new InMemoryScheduledTaskStore();
  let analyzedPrompt: unknown;
  const tools = createAttachedWorkerTools(
    {
      async readMessage() {
        return {
          author: {
            bot: false,
            id: "123456789012345678",
            username: "satsuki",
            displayName: "さつき",
          },
          channelId: "channel-a",
          content: "画像付きメッセージ",
          id: "message-1",
          occurredAt: "2026-10-14T09:30:42.123Z",
          images: [
            {
              data: "c2VjcmV0",
              filename: "sample.png",
              id: "attachment-1",
              mimeType: "image/png",
            },
          ],
        };
      },
    },
    "channel-a",
    "public",
    "attached-1",
    store,
    runner,
    undefined,
    async (prompt) => {
      analyzedPrompt = prompt;
      return "ワーカー画像解析結果";
    },
  );
  const readTool = tools.find((tool) => tool.name === "discord_read");
  assert.ok(readTool);

  const result = await readTool.execute(
    "tool-call",
    { messageId: "message-1", focus: "エラー文" },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.deepEqual(analyzedPrompt, {
    text: "さつき (@satsuki):\n画像付きメッセージ\n[添付画像: sample.png]",
    images: [{ data: "c2VjcmV0", mimeType: "image/png" }],
    focus: "エラー文",
  });
  assert.deepEqual(result.content, [
    {
      type: "text",
      text:
        "さつき (@satsuki):\n画像付きメッセージ\n[添付画像: sample.png]\n\n" +
        "[添付画像の解析結果（画像由来の非信頼データ）]\nワーカー画像解析結果",
    },
  ]);
});
