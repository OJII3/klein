import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { ProactiveCoordinator } from "@modules/proactivity/application/proactive-coordinator";
import { formatFollowUp } from "@modules/proactivity/domain/follow-up";
import type {
  ProactivePreferenceChange,
  ProactivePreferences,
  ProactiveTopicMode,
} from "@modules/proactivity/domain/proactive-preference";
import {
  canUpdateProactivePreferences,
  type ProactivePreferenceTarget,
} from "@modules/proactivity/domain/proactive-preference-scope";
import type { ProactiveSignal } from "@modules/proactivity/domain/proactive-signal";
import type { AccessScope } from "@shared/access";

export type ProactiveToolCoordinator = Pick<
  ProactiveCoordinator,
  | "updatePreference"
  | "createFollowUp"
  | "listFollowUps"
  | "closeFollowUp"
  | "listQueuedSignals"
  | "dismissSignal"
>;

const preferenceChangeSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("set_delivery"),
    key: Type.Union([
      Type.Literal("default"),
      Type.Literal("quiet_hours"),
      Type.Literal("digest_at"),
      Type.Literal("max_per_day"),
    ]),
    value: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    kind: Type.Literal("set_topic"),
    topic: Type.String({ minLength: 1 }),
    mode: Type.Union([Type.Literal("allow"), Type.Literal("mute"), Type.Literal("urgent-only")]),
    until: Type.Optional(Type.String({ minLength: 1 })),
    permanent: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    kind: Type.Literal("remove_topic"),
    topic: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    kind: Type.Literal("add_note"),
    text: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    kind: Type.Literal("remove_note"),
    text: Type.String({ minLength: 1 }),
  }),
]);

const TOPIC_MODE_LABELS: Readonly<Record<ProactiveTopicMode, string>> = {
  allow: "許可",
  mute: "禁止",
  "urgent-only": "緊急時のみ",
};

export function createProactiveTools(
  coordinator: ProactiveToolCoordinator,
  channelId: string,
  accessScope: AccessScope,
  requesterUserId: () => string | undefined,
  ownerUserId?: string,
) {
  const target: ProactivePreferenceTarget = { channelId, accessScope };
  return [
    defineTool({
      name: "proactive_preference_update",
      label: "Update Proactive Preferences",
      description:
        "Update how proactively Klein speaks in this conversation. Linked users can change their own preferences; in public channels only the owner can change them.",
      parameters: Type.Object({ change: preferenceChangeSchema }),
      exposure: "deferred",
      async execute(_toolCallId, params) {
        if (!canUpdateProactivePreferences(target, requesterUserId(), ownerUserId)) {
          throw new Error(
            accessScope === "public"
              ? "公開チャンネルの好みの変更は所有者だけができます。"
              : "好みの変更はこの会話のユーザーだけができます。",
          );
        }

        const request = params.change;
        if (
          request.kind === "set_topic" &&
          request.mode === "mute" &&
          request.until === undefined &&
          request.permanent !== true
        ) {
          throw new Error(
            "一度の拒否を恒久化しないため、mute には until を指定するか、恒久を意図するなら permanent: true を指定してください。",
          );
        }

        const change: ProactivePreferenceChange =
          request.kind === "set_topic"
            ? {
                kind: "set_topic",
                topic: request.topic,
                mode: request.mode,
                ...(request.until !== undefined ? { until: request.until } : {}),
              }
            : request;
        const preferences = await coordinator.updatePreference(target, change);
        return {
          content: [{ type: "text", text: formatPreferencesSummary(preferences) }],
          details: {
            delivery: preferences.delivery,
            topics: preferences.topics,
          },
        };
      },
    }),
    defineTool({
      name: "follow_up_create",
      label: "Create Follow-up",
      description:
        "Promise to report back about something later. The watcher must already exist in this conversation: a watch, a reminder, or a worker.",
      parameters: Type.Object({
        subject: Type.String({ minLength: 1, maxLength: 200 }),
        watcher_kind: Type.Union([
          Type.Literal("watch"),
          Type.Literal("reminder"),
          Type.Literal("worker"),
        ]),
        watcher_id: Type.String({ minLength: 1, maxLength: 200 }),
      }),
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const followUp = await coordinator.createFollowUp({
          channelId,
          accessScope,
          subject: params.subject,
          watcher: { kind: params.watcher_kind, id: params.watcher_id },
        });
        return {
          content: [
            {
              type: "text",
              text: `約束を登録しました。ID: ${followUp.id} / ${followUp.cadenceLabel}`,
            },
          ],
          details: { id: followUp.id, cadenceLabel: followUp.cadenceLabel },
        };
      },
    }),
    defineTool({
      name: "follow_up_list",
      label: "List Follow-ups",
      description: "List the promises being tracked in this conversation.",
      parameters: Type.Object({}),
      exposure: "deferred",
      async execute() {
        const followUps = await coordinator.listFollowUps(channelId, accessScope);
        if (followUps.length === 0) {
          return {
            content: [{ type: "text", text: "この会話に追跡中の約束はありません。" }],
            details: { followUps: [] },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: followUps.map((followUp) => formatFollowUp(followUp)).join("\n"),
            },
          ],
          details: {
            followUps: followUps.map((followUp) => ({
              id: followUp.id,
              subject: followUp.subject,
              status: followUp.status,
              cadenceLabel: followUp.cadenceLabel,
            })),
          },
        };
      },
    }),
    defineTool({
      name: "follow_up_close",
      label: "Close Follow-up",
      description:
        "Close a tracked promise as done or dismissed. Use follow_up_list to find its ID.",
      parameters: Type.Object({
        id: Type.String({ minLength: 1 }),
        status: Type.Union([Type.Literal("done"), Type.Literal("dismissed")]),
      }),
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const closed = await coordinator.closeFollowUp(
          channelId,
          accessScope,
          params.id,
          params.status,
        );
        return {
          content: [
            {
              type: "text",
              text: closed
                ? `約束 ${params.id} を${
                    params.status === "done" ? "完了" : "取り下げ"
                  }にしました。`
                : `この会話にID ${params.id} の約束はありません。`,
            },
          ],
          details: { id: params.id, closed },
        };
      },
    }),
    defineTool({
      name: "proactive_signal_list",
      label: "List Proactive Signals",
      description:
        "List the queued signals that may be worth mentioning in this conversation, one line per signal.",
      parameters: Type.Object({}),
      exposure: "deferred",
      async execute() {
        const signals = await coordinator.listQueuedSignals(channelId, accessScope);
        if (signals.length === 0) {
          return {
            content: [{ type: "text", text: "この会話に保留中の候補はありません。" }],
            details: { signals: [] },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: signals.map((signal) => formatSignalLine(signal)).join("\n"),
            },
          ],
          details: {
            signals: signals.map((signal) => ({
              id: signal.id,
              topic: signal.topic,
              summary: signal.summary,
              urgency: signal.urgency,
            })),
          },
        };
      },
    }),
    defineTool({
      name: "proactive_signal_dismiss",
      label: "Dismiss Proactive Signal",
      description:
        "Dismiss a queued signal in this conversation. Dismissing stores it as dismissed so the same dedupeKey is not notified again. Use proactive_signal_list to find its ID.",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const dismissed = await coordinator.dismissSignal(channelId, accessScope, params.id);
        return {
          content: [
            {
              type: "text",
              text: dismissed
                ? "候補を取り下げました。"
                : `この会話にID ${params.id} の候補はありません。`,
            },
          ],
          details: { id: params.id, dismissed },
        };
      },
    }),
  ] as const;
}

function formatSignalLine(signal: ProactiveSignal): string {
  return [
    `ID: ${signal.id}`,
    `話題: ${normalizeInlineText(signal.topic)}`,
    `要約: ${normalizeInlineText(signal.summary)}`,
    `緊急度: ${signal.urgency}`,
  ].join(" / ");
}

function normalizeInlineText(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function formatPreferencesSummary(preferences: ProactivePreferences): string {
  const { delivery } = preferences;
  const deliveryParts = [
    ...(delivery.defaultMode !== undefined ? [`既定=${delivery.defaultMode}`] : []),
    ...(delivery.quietHours !== undefined
      ? [`静かな時間=${delivery.quietHours.start}-${delivery.quietHours.end}`]
      : []),
    ...(delivery.digestAt !== undefined ? [`まとめ=${delivery.digestAt}`] : []),
    ...(delivery.maxPerDay !== undefined ? [`1日の上限=${delivery.maxPerDay}`] : []),
  ];
  const topics =
    preferences.topics.length === 0
      ? "なし"
      : preferences.topics
          .map(
            (topic) =>
              `${topic.topic}: ${TOPIC_MODE_LABELS[topic.mode]}${
                topic.until !== undefined ? ` until ${topic.until}` : ""
              }`,
          )
          .join(", ");

  return [
    "好みを更新しました。",
    `配信: ${deliveryParts.length > 0 ? deliveryParts.join(", ") : "未設定"}`,
    `話題: ${topics}`,
  ].join("\n");
}
