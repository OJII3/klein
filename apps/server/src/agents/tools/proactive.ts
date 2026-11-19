import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { ProactiveCoordinator } from "@modules/proactivity/application/proactive-coordinator";
import { formatFollowUp } from "@modules/proactivity/domain/follow-up";
import type {
  ProactivePreferenceChange,
  ProactivePreferences,
  ProactiveTopicMode,
} from "@modules/proactivity/domain/proactive-preference";
import { isOwnerAccessScope, type AccessScope } from "@shared/access";

export type ProactiveToolCoordinator = Pick<
  ProactiveCoordinator,
  "updatePreference" | "createFollowUp" | "listFollowUps" | "closeFollowUp"
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
  return [
    defineTool({
      name: "proactive_preference_update",
      label: "Update Proactive Preferences",
      description:
        "Update how proactively Klein speaks in this conversation. Only the owner can change these preferences.",
      parameters: Type.Object({ change: preferenceChangeSchema }),
      exposure: "deferred",
      async execute(_toolCallId, params) {
        if (!isOwnerAccessScope(accessScope, ownerUserId) || requesterUserId() !== ownerUserId) {
          throw new Error("好みの変更は所有者だけができます。");
        }

        const preferences = await coordinator.updatePreference(
          params.change as ProactivePreferenceChange,
        );
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
        "Promise to report back about something later. The watcher must already exist in this conversation: a watch, a reminder, or an attached task.",
      parameters: Type.Object({
        subject: Type.String({ minLength: 1, maxLength: 200 }),
        watcher_kind: Type.Union([
          Type.Literal("watch"),
          Type.Literal("reminder"),
          Type.Literal("task"),
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
  ] as const;
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
