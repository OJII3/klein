import { parseAccessScope, type AccessScope } from "@shared/access";
import { isRecord } from "@shared/type-guards";

import type { ProactiveDeliveryMode } from "./proactive-preference";

export type ProactiveUrgency = "now" | "today" | "digest" | "silent";

export type ProactiveSignalStatus = "queued" | "surfaced" | "dismissed" | "expired";

export interface ProactiveSignal {
  readonly version: 1;
  readonly id: string;
  readonly channelId: string;
  readonly accessScope: AccessScope;
  readonly audience: "owner" | "public";
  readonly source: { kind: "watch" | "worker" | "memory" | "connector"; ref?: string };
  readonly topic: string;
  readonly summary: string;
  readonly evidence?: { url?: string; text?: string };
  readonly urgency: ProactiveUrgency;
  readonly dedupeKey: string;
  readonly observedAt: string;
  readonly expiresAt?: string;
  readonly status: ProactiveSignalStatus;
  readonly delivery?: {
    readonly mode: ProactiveDeliveryMode;
    readonly surfacedAt?: string;
    readonly messageIds?: readonly string[];
  };
}

const SIGNAL_STATUSES: readonly ProactiveSignalStatus[] = [
  "queued",
  "surfaced",
  "dismissed",
  "expired",
];

const URGENCIES: readonly ProactiveUrgency[] = ["now", "today", "digest", "silent"];

const SOURCE_KINDS: readonly ProactiveSignal["source"]["kind"][] = [
  "watch",
  "worker",
  "memory",
  "connector",
];

const DELIVERY_MODES: readonly ProactiveDeliveryMode[] = [
  "interrupt",
  "attach",
  "digest",
  "silent",
];

const URGENCY_LABELS: Readonly<Record<ProactiveUrgency, string>> = {
  now: "今すぐ",
  today: "今日中",
  digest: "まとめ",
  silent: "静か",
};

export function parseProactiveSignal(value: unknown): ProactiveSignal {
  if (!isRecord(value) || value.version !== 1) {
    throw new TypeError("候補の保存形式が不正です。");
  }

  const {
    id,
    channelId,
    audience,
    source,
    topic,
    summary,
    urgency,
    dedupeKey,
    observedAt,
    status,
    evidence,
    delivery,
  } = value;
  const accessScope = parseAccessScope(value.accessScope);
  if (!isRecord(source)) {
    throw new Error("候補の保存内容が不正です。");
  }
  const sourceKind = source.kind;
  const sourceRef = source.ref;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof channelId !== "string" ||
    channelId.length === 0 ||
    accessScope === undefined ||
    (accessScope !== "public" && !/^(?:owner|user):\d+$/u.test(accessScope)) ||
    (audience !== "owner" && audience !== "public") ||
    !isSourceKind(sourceKind) ||
    (sourceRef !== undefined && (typeof sourceRef !== "string" || sourceRef.length === 0)) ||
    typeof topic !== "string" ||
    topic.length === 0 ||
    typeof summary !== "string" ||
    summary.length === 0 ||
    !isUrgency(urgency) ||
    typeof dedupeKey !== "string" ||
    dedupeKey.length === 0 ||
    !isTimestamp(observedAt) ||
    !isSignalStatus(status)
  ) {
    throw new Error("候補の保存内容が不正です。");
  }

  const parsedEvidence = evidence === undefined ? undefined : parseEvidence(evidence);

  return {
    version: 1,
    id,
    channelId,
    accessScope,
    audience,
    source: {
      kind: sourceKind,
      ...(sourceRef !== undefined ? { ref: sourceRef } : {}),
    },
    topic,
    summary,
    ...(parsedEvidence !== undefined ? { evidence: parsedEvidence } : {}),
    urgency,
    dedupeKey,
    observedAt,
    ...optionalTimestamp(value, "expiresAt"),
    status,
    ...(delivery !== undefined ? { delivery: parseDelivery(delivery) } : {}),
  };
}

export function createSignalDedupeKey(input: {
  sourceKind: ProactiveSignal["source"]["kind"];
  sourceRef?: string;
  topic: string;
  evidence?: ProactiveSignal["evidence"];
}): string {
  return JSON.stringify([
    input.sourceKind,
    normalizeInlineText(input.sourceRef ?? ""),
    normalizeInlineText(input.topic).toLowerCase(),
    normalizeInlineText(input.evidence?.url ?? ""),
    normalizeInlineText(input.evidence?.text ?? "").toLowerCase(),
  ]);
}

export function markSignalSurfaced(
  signal: ProactiveSignal,
  mode: ProactiveDeliveryMode,
  now: number,
  messageIds?: readonly string[],
): ProactiveSignal {
  const messageIdsToKeep = messageIds ?? signal.delivery?.messageIds;
  return {
    ...signal,
    status: "surfaced",
    delivery: {
      mode,
      surfacedAt: new Date(now).toISOString(),
      ...(messageIdsToKeep !== undefined && messageIdsToKeep.length > 0
        ? { messageIds: [...messageIdsToKeep] }
        : {}),
    },
  };
}

export function markSignalDismissed(signal: ProactiveSignal, _now: number): ProactiveSignal {
  return { ...signal, status: "dismissed" };
}

export function markSignalExpired(signal: ProactiveSignal, _now: number): ProactiveSignal {
  return { ...signal, status: "expired" };
}

export function isSignalExpired(signal: ProactiveSignal, now: number): boolean {
  return signal.expiresAt !== undefined && Date.parse(signal.expiresAt) <= now;
}

export function formatSignal(signal: ProactiveSignal): string {
  const url = signal.evidence?.url !== undefined ? ` ${signal.evidence.url}` : "";
  return `${normalizeInlineText(signal.summary)}（${normalizeInlineText(signal.topic)} / ${
    URGENCY_LABELS[signal.urgency]
  }）${url}`;
}

function parseEvidence(value: unknown): NonNullable<ProactiveSignal["evidence"]> | undefined {
  if (!isRecord(value)) throw new Error("候補の根拠が不正です。");
  const url = optionalNonEmptyString(value.url);
  const text = optionalNonEmptyString(value.text);
  if (value.url !== undefined && url === undefined) throw new Error("候補の根拠のURLが不正です。");
  if (value.text !== undefined && text === undefined) {
    throw new Error("候補の根拠の本文が不正です。");
  }
  if (url === undefined && text === undefined) return undefined;
  return {
    ...(url !== undefined ? { url } : {}),
    ...(text !== undefined ? { text } : {}),
  };
}

function parseDelivery(value: unknown): NonNullable<ProactiveSignal["delivery"]> {
  if (!isRecord(value)) throw new Error("候補の配信内容が不正です。");
  const { mode, surfacedAt, messageIds } = value;
  if (!isDeliveryMode(mode)) throw new Error("候補の配信内容が不正です。");
  if (surfacedAt !== undefined && !isTimestamp(surfacedAt)) {
    throw new Error("候補の配信日時が不正です。");
  }
  if (
    messageIds !== undefined &&
    (!Array.isArray(messageIds) ||
      messageIds.length === 0 ||
      !messageIds.every((id): id is string => typeof id === "string" && id.length > 0))
  ) {
    throw new Error("候補のメッセージIDが不正です。");
  }
  return {
    mode,
    ...(surfacedAt !== undefined ? { surfacedAt } : {}),
    ...(messageIds !== undefined ? { messageIds: [...messageIds] } : {}),
  };
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isSourceKind(value: unknown): value is ProactiveSignal["source"]["kind"] {
  return SOURCE_KINDS.some((candidate) => candidate === value);
}

function isUrgency(value: unknown): value is ProactiveUrgency {
  return URGENCIES.some((candidate) => candidate === value);
}

function isSignalStatus(value: unknown): value is ProactiveSignalStatus {
  return SIGNAL_STATUSES.some((candidate) => candidate === value);
}

function isDeliveryMode(value: unknown): value is ProactiveDeliveryMode {
  return DELIVERY_MODES.some((candidate) => candidate === value);
}

function optionalTimestamp(value: Record<string, unknown>, key: string): Record<string, string> {
  const entry = value[key];
  if (entry === undefined) return {};
  if (!isTimestamp(entry)) throw new Error(`候補の${key}が不正です。`);
  return { [key]: entry };
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeInlineText(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}
