import assert from "node:assert/strict";

import { test } from "bun:test";

import {
  createSignalDedupeKey,
  formatSignal,
  isSignalExpired,
  markSignalDismissed,
  markSignalExpired,
  markSignalSurfaced,
  parseProactiveSignal,
  type ProactiveSignal,
} from "./proactive-signal";

const observedAt = "2026-11-20T00:00:00.000Z";

const signal: ProactiveSignal = {
  version: 1,
  id: "signal-1",
  channelId: "channel-a",
  accessScope: "owner:123",
  audience: "owner",
  source: { kind: "watch", ref: "watch-1" },
  topic: "weather",
  summary: "雨が降りそう",
  evidence: { url: "https://example.com/weather", text: "降水確率 80%" },
  urgency: "today",
  dedupeKey: "dedupe-1",
  observedAt,
  status: "queued",
};

test("parses a stored signal with optional evidence and delivery", () => {
  const stored = {
    ...signal,
    expiresAt: "2026-11-21T00:00:00.000Z",
    delivery: {
      mode: "attach",
      surfacedAt: "2026-11-20T01:00:00.000Z",
      messageIds: ["message-1", "message-2"],
    },
  };
  assert.deepEqual(parseProactiveSignal(JSON.parse(JSON.stringify(stored))), stored);
  assert.deepEqual(parseProactiveSignal(signal), signal);
});

test("accepts a linked user scope", () => {
  assert.equal(
    parseProactiveSignal({ ...signal, accessScope: "user:456" }).accessScope,
    "user:456",
  );
});

test("rejects malformed signal records", () => {
  assert.throws(() => parseProactiveSignal(null), /保存形式/u);
  assert.throws(() => parseProactiveSignal({ ...signal, version: 2 }), /保存形式/u);
  assert.throws(() => parseProactiveSignal({ ...signal, id: "" }), /保存内容/u);
  assert.throws(() => parseProactiveSignal({ ...signal, accessScope: "public:1" }), /保存内容/u);
  assert.throws(() => parseProactiveSignal({ ...signal, audience: "everyone" }), /保存内容/u);
  assert.throws(() => parseProactiveSignal({ ...signal, source: { kind: "cron" } }), /保存内容/u);
  assert.throws(
    () => parseProactiveSignal({ ...signal, source: { kind: "watch", ref: "" } }),
    /保存内容/u,
  );
  assert.throws(() => parseProactiveSignal({ ...signal, topic: "" }), /保存内容/u);
  assert.throws(() => parseProactiveSignal({ ...signal, urgency: "soon" }), /保存内容/u);
  assert.throws(() => parseProactiveSignal({ ...signal, dedupeKey: "" }), /保存内容/u);
  assert.throws(() => parseProactiveSignal({ ...signal, observedAt: "now" }), /保存内容/u);
  assert.throws(() => parseProactiveSignal({ ...signal, status: "waiting" }), /保存内容/u);
  assert.throws(() => parseProactiveSignal({ ...signal, evidence: { url: "" } }), /根拠/u);
  assert.throws(() => parseProactiveSignal({ ...signal, evidence: { text: 1 } }), /根拠/u);
  assert.throws(
    () => parseProactiveSignal({ ...signal, delivery: { mode: "shout" } }),
    /配信内容/u,
  );
  assert.throws(
    () => parseProactiveSignal({ ...signal, delivery: { mode: "attach", surfacedAt: "now" } }),
    /配信日時/u,
  );
  assert.throws(
    () => parseProactiveSignal({ ...signal, delivery: { mode: "attach", messageIds: [] } }),
    /メッセージID/u,
  );
});

test("builds a stable dedupe key from source, topic, and evidence", () => {
  const base = {
    sourceKind: "watch" as const,
    sourceRef: "watch-1",
    topic: "CI failure",
    evidence: { url: "https://example.com/ci", text: "Build 42 failed" },
  };
  const key = createSignalDedupeKey(base);

  assert.equal(createSignalDedupeKey({ ...base }), key);
  assert.equal(
    createSignalDedupeKey({
      ...base,
      topic: "  ci   FAILURE ",
      evidence: { ...base.evidence, text: "  build 42   failed " },
    }),
    key,
  );
  assert.notEqual(createSignalDedupeKey({ ...base, sourceRef: "watch-2" }), key);
  assert.notEqual(createSignalDedupeKey({ ...base, topic: "release" }), key);
  assert.notEqual(
    createSignalDedupeKey({
      ...base,
      evidence: { ...base.evidence, url: "https://example.com/other" },
    }),
    key,
  );
  assert.notEqual(createSignalDedupeKey({ ...base, evidence: { text: "Build 42 failed" } }), key);
  assert.equal(
    createSignalDedupeKey({ sourceKind: "worker", topic: "done" }),
    createSignalDedupeKey({ sourceKind: "worker", sourceRef: "", topic: "done" }),
  );
});

test("marks a signal surfaced with its delivery details", () => {
  const now = Date.parse("2026-11-20T03:04:05.000Z");
  const surfaced = markSignalSurfaced(signal, "attach", now, ["message-1", "message-2"]);

  assert.equal(surfaced.status, "surfaced");
  assert.deepEqual(surfaced.delivery, {
    mode: "attach",
    surfacedAt: "2026-11-20T03:04:05.000Z",
    messageIds: ["message-1", "message-2"],
  });
  assert.equal(signal.status, "queued");
  assert.equal(signal.delivery, undefined);

  const withoutNewIds = markSignalSurfaced(surfaced, "digest", now);
  assert.deepEqual(withoutNewIds.delivery?.messageIds, ["message-1", "message-2"]);
  assert.equal(withoutNewIds.delivery?.mode, "digest");
});

test("dismisses and expires a signal without inventing a surfaced time", () => {
  const now = Date.parse("2026-11-20T03:04:05.000Z");
  const dismissed = markSignalDismissed(signal, Date.now());
  const expired = markSignalExpired(signal, Date.now());

  assert.equal(dismissed.status, "dismissed");
  assert.equal(dismissed.delivery, undefined);
  assert.equal(expired.status, "expired");
  assert.equal(expired.delivery, undefined);

  const surfaced = markSignalSurfaced(signal, "attach", Date.parse(observedAt));
  const laterDismissed = markSignalDismissed(surfaced, Date.now());
  assert.deepEqual(laterDismissed.delivery, surfaced.delivery);

  const withoutMessages = markSignalSurfaced(signal, "attach", now, []);
  assert.deepEqual(withoutMessages.delivery, {
    mode: "attach",
    surfacedAt: "2026-11-20T03:04:05.000Z",
  });
});

test("expires a signal at or after its expiry", () => {
  const expiring = { ...signal, expiresAt: "2026-11-21T00:00:00.000Z" };

  assert.equal(isSignalExpired(signal, Date.now()), false);
  assert.equal(isSignalExpired(expiring, Date.parse("2026-11-20T23:59:59.999Z")), false);
  assert.equal(isSignalExpired(expiring, Date.parse("2026-11-21T00:00:00.000Z")), true);
  assert.equal(isSignalExpired(expiring, Date.parse("2026-11-21T00:00:00.001Z")), true);
});

test("formats a signal as one line with topic, urgency, and evidence URL", () => {
  assert.equal(
    formatSignal({ ...signal, summary: "  雨が\n降りそう " }),
    "雨が 降りそう (weather / today) https://example.com/weather",
  );
  assert.equal(
    formatSignal({ ...signal, urgency: "now", evidence: undefined }),
    "雨が降りそう (weather / now)",
  );
  assert.equal(
    formatSignal({ ...signal, urgency: "digest" }),
    "雨が降りそう (weather / digest) https://example.com/weather",
  );
  assert.equal(
    formatSignal({ ...signal, urgency: "silent" }),
    "雨が降りそう (weather / silent) https://example.com/weather",
  );
});
