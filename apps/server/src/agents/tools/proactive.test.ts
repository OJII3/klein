import assert from "node:assert/strict";
import test from "node:test";

import { createStubExtensionToolContext } from "@agents/testing/test-stubs";
import type { FollowUp } from "@modules/proactivity/domain/follow-up";
import type { ProactivePreferences } from "@modules/proactivity/domain/proactive-preference";
import { isRecord } from "@shared/type-guards";

import { createProactiveTools, type ProactiveToolCoordinator } from "./proactive";

const preferences: ProactivePreferences = {
  delivery: { defaultMode: "attach", maxPerDay: 2 },
  topics: [{ topic: "weather", mode: "mute", until: "2026-12-01" }],
  notes: ["このメモはツールの応答に出さない"],
};

const followUp: FollowUp = {
  version: 1,
  id: "follow-up-1",
  channelId: "channel-a",
  accessScope: "owner:123",
  subject: "天気を確認する",
  watcher: { kind: "watch", id: "watch-1" },
  cadenceLabel: "5分ごと",
  status: "active",
  createdAt: "2026-11-20T00:00:00.000Z",
  updatedAt: "2026-11-20T00:00:00.000Z",
};

function createCoordinator(
  overrides: Partial<ProactiveToolCoordinator> = {},
): ProactiveToolCoordinator {
  return {
    async updatePreference() {
      return preferences;
    },
    async createFollowUp() {
      return followUp;
    },
    async listFollowUps() {
      return [];
    },
    async closeFollowUp() {
      return true;
    },
    ...overrides,
  };
}

function textOf(result: { content: readonly unknown[] }): string {
  const block = result.content[0];
  return isRecord(block) && block.type === "text" && typeof block.text === "string"
    ? block.text
    : "";
}

test("updates preferences only for the owner who started the turn", async () => {
  const changes: unknown[] = [];
  const coordinator = createCoordinator({
    async updatePreference(change) {
      changes.push(change);
      return preferences;
    },
  });
  const ctx = await createStubExtensionToolContext();
  const change = { kind: "set_delivery", key: "max_per_day", value: "2" } as const;

  const publicTools = createProactiveTools(
    coordinator,
    "channel-a",
    "public",
    () => "user-1",
    "user-1",
  );
  await assert.rejects(
    publicTools[0].execute("tool-call", { change }, undefined, undefined, ctx),
    /所有者/u,
  );

  const otherRequesterTools = createProactiveTools(
    coordinator,
    "channel-a",
    "owner:user-1",
    () => "user-2",
    "user-1",
  );
  await assert.rejects(
    otherRequesterTools[0].execute("tool-call", { change }, undefined, undefined, ctx),
    /所有者/u,
  );

  const ownerTools = createProactiveTools(
    coordinator,
    "channel-a",
    "owner:user-1",
    () => "user-1",
    "user-1",
  );
  const result = await ownerTools[0].execute("tool-call", { change }, undefined, undefined, ctx);
  const text = textOf(result);

  assert.deepEqual(changes, [change]);
  assert.match(text, /配信: 既定=attach, 1日の上限=2/u);
  assert.match(text, /話題: weather: 禁止 until 2026-12-01/u);
  assert.doesNotMatch(text, /このメモはツールの応答に出さない/u);
});

test("creates follow-ups and reports the watcher cadence", async () => {
  const inputs: unknown[] = [];
  const coordinator = createCoordinator({
    async createFollowUp(input) {
      inputs.push(input);
      return followUp;
    },
  });
  const tools = createProactiveTools(
    coordinator,
    "channel-a",
    "owner:123",
    () => "user-1",
    "user-1",
  );
  const ctx = await createStubExtensionToolContext();

  const result = await tools[1].execute(
    "tool-call",
    { subject: "天気を確認する", watcher_kind: "watch", watcher_id: "watch-1" },
    undefined,
    undefined,
    ctx,
  );

  assert.deepEqual(inputs, [
    {
      channelId: "channel-a",
      accessScope: "owner:123",
      subject: "天気を確認する",
      watcher: { kind: "watch", id: "watch-1" },
    },
  ]);
  assert.match(textOf(result), /follow-up-1/u);
  assert.match(textOf(result), /5分ごと/u);

  const failing = createProactiveTools(
    createCoordinator({
      async createFollowUp() {
        throw new Error("指定した追跡対象がこの会話に見つかりません。");
      },
    }),
    "channel-a",
    "owner:123",
    () => "user-1",
    "user-1",
  );
  await assert.rejects(
    failing[1].execute(
      "tool-call",
      { subject: "天気を確認する", watcher_kind: "reminder", watcher_id: "missing" },
      undefined,
      undefined,
      ctx,
    ),
    /見つかりません/u,
  );
});

test("lists follow-ups one line each or reports an empty ledger", async () => {
  const ctx = await createStubExtensionToolContext();
  const emptyTools = createProactiveTools(
    createCoordinator(),
    "channel-a",
    "owner:123",
    () => "user-1",
    "user-1",
  );
  const emptyResult = await emptyTools[2].execute("tool-call", {}, undefined, undefined, ctx);
  assert.equal(textOf(emptyResult), "この会話に追跡中の約束はありません。");

  const tools = createProactiveTools(
    createCoordinator({
      async listFollowUps() {
        return [followUp, { ...followUp, id: "follow-up-2", subject: "リリースを確認する" }];
      },
    }),
    "channel-a",
    "owner:123",
    () => "user-1",
    "user-1",
  );
  const result = await tools[2].execute("tool-call", {}, undefined, undefined, ctx);
  assert.deepEqual(textOf(result).split("\n"), [
    "天気を確認する（5分ごと / 追跡中）",
    "リリースを確認する（5分ごと / 追跡中）",
  ]);
});

test("closes a follow-up and distinguishes a missing one", async () => {
  const closed: unknown[] = [];
  const tools = createProactiveTools(
    createCoordinator({
      async closeFollowUp(channelId, accessScope, id, status) {
        closed.push({ channelId, accessScope, id, status });
        return id === "follow-up-1";
      },
    }),
    "channel-a",
    "owner:123",
    () => "user-1",
    "user-1",
  );
  const ctx = await createStubExtensionToolContext();

  const done = await tools[3].execute(
    "tool-call",
    { id: "follow-up-1", status: "done" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(textOf(done), /完了/u);
  assert.deepEqual(closed, [
    { channelId: "channel-a", accessScope: "owner:123", id: "follow-up-1", status: "done" },
  ]);

  const missing = await tools[3].execute(
    "tool-call",
    { id: "missing", status: "dismissed" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(textOf(missing), /ありません/u);
});
