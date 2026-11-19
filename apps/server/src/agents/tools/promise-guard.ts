import type { Logger } from "pino";

import type { FollowUp } from "@modules/proactivity/domain/follow-up";

export type PromiseGuardMode = "off" | "log" | "block";

export interface PromiseGuardDecision {
  readonly action: "allow" | "log" | "block";
  readonly reason?: string;
}

export interface PromiseGuard {
  check(content: string): Promise<PromiseGuardDecision>;
}

const PROMISE_PATTERNS: readonly RegExp[] = [
  /(?:見つけ|見つかっ|変わっ|届い|届き|到着し|更新され|終わっ|完了し)(?:たら|れば|次第).{0,20}(?:教え|知らせ|連絡|報告)/u,
  /(?:監視|チェック|確認)(?:しておく|しておきます|しとく|しときます)/u,
  /(?:後で|あとで).{0,10}(?:教え|知らせ|連絡|報告)/u,
];

const LOG_CONTENT_LIMIT = 120;

export function createPromiseGuard(options: {
  mode: PromiseGuardMode;
  channelId: string;
  listActiveFollowUps: () => Promise<readonly FollowUp[]>;
  logger?: Logger;
}): PromiseGuard {
  return {
    async check(content) {
      if (!hasPromiseWording(content)) return { action: "allow" };

      const followUps = await options.listActiveFollowUps();
      if (followUps.length > 0) return { action: "allow" };

      if (options.mode === "off") return { action: "allow" };
      if (options.mode === "log") {
        options.logger?.warn(
          {
            event: "proactive_promise_guard",
            channelId: options.channelId,
            content: content.slice(0, LOG_CONTENT_LIMIT),
          },
          "A message promised a follow-up without a tracked follow-up",
        );
        return { action: "log", reason: "no-active-follow-up" };
      }
      return { action: "block", reason: "no-active-follow-up" };
    },
  };
}

function hasPromiseWording(content: string): boolean {
  return PROMISE_PATTERNS.some((pattern) => pattern.test(content));
}
