import assert from "node:assert/strict";
import test from "node:test";

import { createStubExtensionToolContext } from "@agents/testing/test-stubs";
import type { FollowUp } from "@modules/proactivity/domain/follow-up";
import type { ProactivePreferences } from "@modules/proactivity/domain/proactive-preference";
import type { ProactiveSignal } from "@modules/proactivity/domain/proactive-signal";
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

const signal: ProactiveSignal = {
  version: 1,
  id: "signal-1",
  channelId: "channel-a",
  accessScope: "owner:123",
  audience: "owner",
  source: { kind: "watch", ref: "watch-1" },
  topic: "在庫監視",
  summary: "在庫が3個になりました",
  urgency: "today",
  dedupeKey: "dedupe-1",
  observedAt: "2026-11-20T00:00:00.000Z",
  status: "queued",
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
    async listQueuedSignals() {
      return [];
    },
    async dismissSignal() {
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

test("lets linked users update their own preferences and keeps public channels owner-only", async () => {
  const updates: unknown[] = [];
  const coordinator = createCoordinator({
    async updatePreference(target, change) {
      updates.push({ target, change });
      return preferences;
    },
  });
  const ctx = await createStubExtensionToolContext();
  const change = { kind: "set_delivery", key: "max_per_day", value: "2" } as const;

  const ownerPublicTools = createProactiveTools(
    coordinator,
    "channel-a",
    "public",
    () => "user-1",
    "user-1",
  );
  await assert.rejects(
    createProactiveTools(coordinator, "channel-a", "public", () => "user-2", "user-1")[0].execute(
      "tool-call",
      { change },
      undefined,
      undefined,
      ctx,
    ),
    /所有者/u,
  );
  await ownerPublicTools[0].execute("tool-call", { change }, undefined, undefined, ctx);

  const otherRequesterTools = createProactiveTools(
    coordinator,
    "channel-a",
    "owner:user-1",
    () => "user-2",
    "user-1",
  );
  await assert.rejects(
    otherRequesterTools[0].execute("tool-call", { change }, undefined, undefined, ctx),
    /この会話のユーザー/u,
  );

  const ownerTools = createProactiveTools(
    coordinator,
    "channel-a",
    "owner:user-1",
    () => "user-1",
    "user-1",
  );
  await ownerTools[0].execute("tool-call", { change }, undefined, undefined, ctx);

  const linkedUserTools = createProactiveTools(
    coordinator,
    "channel-b",
    "user:user-2",
    () => "user-2",
    "user-1",
  );
  const result = await linkedUserTools[0].execute(
    "tool-call",
    { change },
    undefined,
    undefined,
    ctx,
  );
  const text = textOf(result);

  await assert.rejects(
    createProactiveTools(
      coordinator,
      "channel-b",
      "user:user-2",
      () => "user-3",
      "user-1",
    )[0].execute("tool-call", { change }, undefined, undefined, ctx),
    /この会話のユーザー/u,
  );

  assert.deepEqual(updates, [
    { target: { channelId: "channel-a", accessScope: "public" }, change },
    { target: { channelId: "channel-a", accessScope: "owner:user-1" }, change },
    { target: { channelId: "channel-b", accessScope: "user:user-2" }, change },
  ]);
  assert.match(text, /配信: 既定=attach, 1日の上限=2/u);
  assert.match(text, /話題: weather: 禁止 until 2026-12-01/u);
  assert.doesNotMatch(text, /このメモはツールの応答に出さない/u);
});

test("requires permanent: true for an open-ended mute", async () => {
  const changes: unknown[] = [];
  const tools = createProactiveTools(
    createCoordinator({
      async updatePreference(_target, change) {
        changes.push(change);
        return preferences;
      },
    }),
    "channel-a",
    "owner:user-1",
    () => "user-1",
    "user-1",
  );
  const ctx = await createStubExtensionToolContext();
  const update = tools[0];

  await update.execute(
    "tool-call",
    { change: { kind: "set_topic", topic: "weather", mode: "mute", until: "2026-12-01" } },
    undefined,
    undefined,
    ctx,
  );
  await update.execute(
    "tool-call",
    { change: { kind: "set_topic", topic: "weather", mode: "mute", permanent: true } },
    undefined,
    undefined,
    ctx,
  );
  await assert.rejects(
    update.execute(
      "tool-call",
      { change: { kind: "set_topic", topic: "weather", mode: "mute" } },
      undefined,
      undefined,
      ctx,
    ),
    /一度の拒否を恒久化しないため、mute には until を指定するか、恒久を意図するなら permanent: true を指定してください。/u,
  );

  assert.deepEqual(changes, [
    { kind: "set_topic", topic: "weather", mode: "mute", until: "2026-12-01" },
    { kind: "set_topic", topic: "weather", mode: "mute" },
  ]);
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

test("lists queued signals and dismisses them by id", async () => {
  const dismissed: unknown[] = [];
  const tools = createProactiveTools(
    createCoordinator({
      async listQueuedSignals() {
        return [signal, { ...signal, id: "signal-2", summary: "二つ目" }];
      },
      async dismissSignal(channelId, accessScope, id) {
        dismissed.push({ channelId, accessScope, id });
        return id === "signal-1";
      },
    }),
    "channel-a",
    "owner:123",
    () => "user-1",
    "user-1",
  );
  const ctx = await createStubExtensionToolContext();

  const list = await tools[4].execute("tool-call", {}, undefined, undefined, ctx);
  assert.deepEqual(textOf(list).split("\n"), [
    "ID: signal-1 / 話題: 在庫監視 / 要約: 在庫が3個になりました / 緊急度: today",
    "ID: signal-2 / 話題: 在庫監視 / 要約: 二つ目 / 緊急度: today",
  ]);

  const empty = createProactiveTools(
    createCoordinator(),
    "channel-a",
    "owner:123",
    () => "user-1",
    "user-1",
  );
  const emptyResult = await empty[4].execute("tool-call", {}, undefined, undefined, ctx);
  assert.equal(textOf(emptyResult), "この会話に保留中の候補はありません。");

  const removed = await tools[5].execute(
    "tool-call",
    { id: "signal-1" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(textOf(removed), "候補を取り下げました。");
  const missing = await tools[5].execute("tool-call", { id: "missing" }, undefined, undefined, ctx);
  assert.match(textOf(missing), /ありません/u);
  assert.deepEqual(dismissed, [
    { channelId: "channel-a", accessScope: "owner:123", id: "signal-1" },
    { channelId: "channel-a", accessScope: "owner:123", id: "missing" },
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
