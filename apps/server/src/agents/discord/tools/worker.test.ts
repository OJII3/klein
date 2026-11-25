import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryScheduledTaskStore,
  createStubDiscordChannelApi,
  createStubExtensionToolContext,
} from "@agents/testing/test-stubs";
import type { CodingBackend } from "@modules/coding/ports/coding-backend";
import { CodingBackendRegistry } from "@modules/coding/application/coding-backend-registry";
import type { DiscordUserProfile } from "@modules/discord/domain/discord-user-profile";
import type { WatchCheckRunner } from "@modules/scheduling/ports/watch-check-runner";
import { createWorkerTools } from "./worker";

const runner: WatchCheckRunner = {
  async run() {
    return { output: "", decision: "silent", exitCode: 0, durationMs: 0, state: {} };
  },
};

test("gives a worker the read tool and its own watch tools", () => {
  const store = new InMemoryScheduledTaskStore();
  const tools = createWorkerTools(
    createStubDiscordChannelApi(),
    "channel-a",
    "public",
    "worker-1",
    store,
    runner,
  );

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["discord_read", "watch_add", "watch_update", "watch_list", "watch_get", "watch_delete"],
  );
});

test("adds the Discord user profile tool when profile dependencies are supplied", () => {
  const profile: DiscordUserProfile = {
    id: "1",
    username: "alice",
    displayName: "Alice",
    bot: false,
    accountCreatedAt: "2020-01-01T00:00:00.000Z",
    flags: [],
  };
  const tools = createWorkerTools(
    createStubDiscordChannelApi(),
    "channel-a",
    "public",
    "worker-1",
    new InMemoryScheduledTaskStore(),
    runner,
    undefined,
    undefined,
    undefined,
    {
      users: {
        resolve: (username) =>
          username === "alice"
            ? { id: "1", username: "alice", displayName: "Alice", bot: false }
            : undefined,
      },
      profiles: { readUserProfile: async () => profile },
    },
  );

  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "discord_read",
      "discord_user_profile",
      "watch_add",
      "watch_update",
      "watch_list",
      "watch_get",
      "watch_delete",
    ],
  );
});

test("registers a worker watch with the worker id", async () => {
  const store = new InMemoryScheduledTaskStore();
  const tools = createWorkerTools(
    createStubDiscordChannelApi(),
    "channel-a",
    "public",
    "worker-1",
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
  assert.equal(watch?.kind === "watch" ? watch.ownerWorkerId : undefined, "worker-1");
});

test("adds coding tools only when a backend registry is supplied", () => {
  const store = new InMemoryScheduledTaskStore();
  const codingBackend: CodingBackend = {
    id: "stub",
    label: "Stub",
    capabilities: {
      projects: true,
      worktree: false,
      questions: false,
      pullRequest: false,
    },
    async listProjects() {
      return [];
    },
    async list() {
      return [];
    },
    async start() {
      return { taskId: "task-1", status: "completed" };
    },
    async send() {
      return { taskId: "task-1", status: "completed" };
    },
    async wait() {
      return {
        task: { id: "task-1", title: "T", status: "completed" },
        messages: [],
        timedOut: false,
      };
    },
    async show() {
      return {
        task: { id: "task-1", title: "T", status: "completed" },
        messages: [],
      };
    },
  };
  const codingBackends = new CodingBackendRegistry([codingBackend]);

  const withoutCoding = createWorkerTools(
    createStubDiscordChannelApi(),
    "channel-a",
    "public",
    "worker-1",
    store,
    runner,
  );
  const withCoding = createWorkerTools(
    createStubDiscordChannelApi(),
    "channel-a",
    "owner:1",
    "worker-1",
    store,
    runner,
    undefined,
    undefined,
    codingBackends,
  );

  assert.equal(
    withoutCoding.some((tool) => tool.name.startsWith("coding_")),
    false,
  );
  assert.deepEqual(
    withCoding.filter((tool) => tool.name.startsWith("coding_")).map((tool) => tool.name),
    [
      "coding_project_list",
      "coding_backend_list",
      "coding_task_start",
      "coding_task_send",
      "coding_task_wait",
      "coding_task_show",
      "coding_task_list",
    ],
  );
});

test("wires image analysis into the worker's discord_read tool", async () => {
  const store = new InMemoryScheduledTaskStore();
  let analyzedPrompt: unknown;
  const tools = createWorkerTools(
    {
      async getChannelLocation(channelId) {
        return { channelId };
      },
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
    "worker-1",
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
