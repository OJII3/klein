import assert from "node:assert/strict";

import { test } from "bun:test";

import {
  formatFollowUp,
  isFollowUpExpired,
  markFollowUpDone,
  markFollowUpExpired,
  markFollowUpNotified,
  markFollowUpOrphaned,
  parseFollowUp,
  type FollowUp,
} from "./follow-up";

const createdAt = "2026-11-20T00:00:00.000Z";

const followUp: FollowUp = {
  version: 1,
  id: "follow-up-1",
  channelId: "channel-a",
  accessScope: "owner:123",
  subject: "牛乳の買い置きを確認する",
  watcher: { kind: "watch", id: "watch-1" },
  cadenceLabel: "5分ごと",
  status: "active",
  createdAt,
  updatedAt: createdAt,
  originMessageId: "message-1",
};

test("parses a stored follow-up with all optional fields", () => {
  const stored = {
    ...followUp,
    expiresAt: "2026-12-01T00:00:00.000Z",
    lastNotifiedAt: "2026-11-20T01:00:00.000Z",
  };
  assert.deepEqual(parseFollowUp(JSON.parse(JSON.stringify(stored))), stored);
  assert.deepEqual(parseFollowUp(followUp), followUp);
});

test("reads the legacy task watcher as a worker", () => {
  const legacy = { ...followUp, watcher: { kind: "task", id: "worker-1" } };

  assert.deepEqual(parseFollowUp(legacy).watcher, { kind: "worker", id: "worker-1" });
});

test("accepts a linked user scope", () => {
  assert.equal(parseFollowUp({ ...followUp, accessScope: "user:456" }).accessScope, "user:456");
});

test("rejects malformed follow-up records", () => {
  assert.throws(() => parseFollowUp(null), /保存形式/u);
  assert.throws(() => parseFollowUp({ ...followUp, version: 2 }), /保存形式/u);
  assert.throws(() => parseFollowUp({ ...followUp, id: "" }), /保存内容/u);
  assert.throws(() => parseFollowUp({ ...followUp, accessScope: "group:1" }), /保存内容/u);
  assert.throws(
    () => parseFollowUp({ ...followUp, watcher: { kind: "cron", id: "x" } }),
    /保存内容/u,
  );
  assert.throws(
    () => parseFollowUp({ ...followUp, watcher: { kind: "watch", id: "" } }),
    /保存内容/u,
  );
  assert.throws(() => parseFollowUp({ ...followUp, status: "waiting" }), /保存内容/u);
  assert.throws(() => parseFollowUp({ ...followUp, createdAt: "yesterday" }), /保存内容/u);
  assert.throws(() => parseFollowUp({ ...followUp, expiresAt: "later" }), /expiresAt/u);
  assert.throws(() => parseFollowUp({ ...followUp, originMessageId: "" }), /originMessageId/u);
});

test("marks a follow-up notified with one timestamp", () => {
  const now = Date.parse("2026-11-20T03:04:05.000Z");
  const notified = markFollowUpNotified(followUp, now);

  assert.equal(notified.status, "notified");
  assert.equal(notified.updatedAt, "2026-11-20T03:04:05.000Z");
  assert.equal(notified.lastNotifiedAt, "2026-11-20T03:04:05.000Z");
  assert.equal(followUp.status, "active");
  assert.equal(followUp.updatedAt, createdAt);
});

test("moves a follow-up through its terminal states without losing history", () => {
  const now = Date.parse("2026-11-20T04:00:00.000Z");
  const notified = markFollowUpNotified(followUp, now);

  for (const [status, transition] of [
    ["done", markFollowUpDone],
    ["orphaned", markFollowUpOrphaned],
    ["expired", markFollowUpExpired],
  ] as const) {
    const updated = transition(notified, now);

    assert.equal(updated.status, status);
    assert.equal(updated.updatedAt, "2026-11-20T04:00:00.000Z");
    assert.equal(updated.lastNotifiedAt, "2026-11-20T04:00:00.000Z");
    assert.equal(updated.subject, followUp.subject);
    assert.equal(notified.status, "notified");
  }
});

test("expires a follow-up at or after its expiry", () => {
  const expiring = { ...followUp, expiresAt: "2026-11-21T00:00:00.000Z" };

  assert.equal(isFollowUpExpired(followUp, Date.now()), false);
  assert.equal(isFollowUpExpired(expiring, Date.parse("2026-11-20T23:59:59.999Z")), false);
  assert.equal(isFollowUpExpired(expiring, Date.parse("2026-11-21T00:00:00.000Z")), true);
  assert.equal(isFollowUpExpired(expiring, Date.parse("2026-11-21T00:00:00.001Z")), true);
});

test("formats a follow-up as one line with its status", () => {
  assert.equal(
    formatFollowUp({ ...followUp, subject: "  牛乳\nを確認 " }),
    "牛乳 を確認（5分ごと / 追跡中）",
  );
  assert.equal(
    formatFollowUp({ ...followUp, status: "done" }),
    "牛乳の買い置きを確認する（5分ごと / 完了）",
  );
  assert.equal(
    formatFollowUp({ ...followUp, status: "orphaned" }),
    "牛乳の買い置きを確認する（5分ごと / 監視なし）",
  );
  assert.equal(
    formatFollowUp({ ...followUp, status: "dismissed" }),
    "牛乳の買い置きを確認する（5分ごと / 取り下げ）",
  );
});
