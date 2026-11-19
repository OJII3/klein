import assert from "node:assert/strict";
import test from "node:test";
import pino, { type Logger } from "pino";

import type { FollowUp } from "@modules/proactivity/domain/follow-up";
import { isRecord } from "@shared/type-guards";

import { createPromiseGuard, type PromiseGuardMode } from "./promise-guard";

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

function createGuard(
  mode: PromiseGuardMode,
  listActiveFollowUps: () => Promise<readonly FollowUp[]> = async () => [],
  logger?: Logger,
) {
  return createPromiseGuard({
    mode,
    channelId: "channel-a",
    listActiveFollowUps,
    ...(logger ? { logger } : {}),
  });
}

test("detects conditional reports, ongoing checks, and later reports", async () => {
  const guard = createGuard("block");
  for (const content of [
    "見つけたら教えるね",
    "変わったら知らせる",
    "届いたら連絡する",
    "監視しておく",
    "チェックしておきます",
    "確認しとく",
    "後で教える",
    "あとで報告します",
  ]) {
    assert.equal((await guard.check(content)).action, "block", content);
  }
});

test("allows text that does not promise a follow-up", async () => {
  const guard = createGuard("block");
  for (const content of [
    "今日はいい天気ですね。",
    "見つけたら嬉しいな",
    "監視カメラを設置しました",
    "確認したらしい",
    "後で食べよう",
    "届いた荷物を開けた",
  ]) {
    assert.equal((await guard.check(content)).action, "allow", content);
  }
});

test("allows a promise when an active follow-up exists", async () => {
  const guard = createGuard("block", async () => [followUp]);

  assert.deepEqual(await guard.check("後で報告します"), { action: "allow" });
});

test("logs a promise without a follow-up and keeps only the content preview", async () => {
  const logs: Record<string, unknown>[] = [];
  const logger = pino(
    { level: "warn" },
    {
      write(line: string) {
        const parsed: unknown = JSON.parse(line);
        if (isRecord(parsed)) logs.push(parsed);
      },
    },
  );
  const guard = createGuard("log", async () => [], logger);
  const content = `後で報告します。${"あ".repeat(200)}`;

  assert.deepEqual(await guard.check(content), {
    action: "log",
    reason: "no-active-follow-up",
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.event, "proactive_promise_guard");
  assert.equal(logs[0]?.channelId, "channel-a");
  assert.equal(logs[0]?.content, content.slice(0, 120));
});

test("blocks without sending when the mode is block", async () => {
  const guard = createGuard("block");

  assert.deepEqual(await guard.check("確認しておく"), {
    action: "block",
    reason: "no-active-follow-up",
  });
});

test("allows everything in off mode", async () => {
  const guard = createGuard("off");

  assert.deepEqual(await guard.check("後で報告します"), { action: "allow" });
});
