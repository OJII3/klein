import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { InitiativeCoordinator } from "@modules/initiative/application/initiative-coordinator";
import { formatGoal, isActiveGoal } from "@modules/initiative/domain/initiative-goal";
import type { AccessScope } from "@shared/access";

export type InitiativeToolCoordinator = Pick<
  InitiativeCoordinator,
  "createGoalFromConversation" | "listGoals" | "dismissGoal"
>;

const goalDeliverySchema = Type.Union([
  Type.Literal("interrupt"),
  Type.Literal("attach"),
  Type.Literal("digest"),
  Type.Literal("silent"),
]);

export function createInitiativeTools(
  coordinator: InitiativeToolCoordinator,
  channelId: string,
  accessScope: AccessScope,
) {
  return [
    defineTool({
      name: "goal_create",
      label: "Create Initiative Goal",
      description:
        "Create a goal for yourself to do later in this conversation. Use it when the user shows clear interest in something you could research, try, or recommend. The plan must be self-contained for a worker. due_at must be an ISO 8601 timestamp with a timezone. Only low-risk goals are accepted for now.",
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 200 }),
        rationale: Type.String({ minLength: 1, maxLength: 2_000 }),
        plan: Type.String({ minLength: 1, maxLength: 8_000 }),
        due_at: Type.String({ minLength: 1 }),
        expires_at: Type.Optional(Type.String({ minLength: 1 })),
        risk: Type.Optional(
          Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
        ),
        delivery: Type.Optional(goalDeliverySchema),
        source_message_ids: Type.Optional(
          Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 }),
        ),
      }),
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const goal = await coordinator.createGoalFromConversation({
          channelId,
          accessScope,
          title: params.title,
          rationale: params.rationale,
          plan: params.plan,
          dueAt: params.due_at,
          ...(params.expires_at !== undefined ? { expiresAt: params.expires_at } : {}),
          ...(params.risk !== undefined ? { risk: params.risk } : {}),
          ...(params.delivery !== undefined ? { delivery: params.delivery } : {}),
          ...(params.source_message_ids !== undefined
            ? { sourceMessageIds: params.source_message_ids }
            : {}),
        });
        return {
          content: [
            { type: "text", text: `Goal を作成しました。ID: ${goal.id} / ${formatGoal(goal)}` },
          ],
          details: { id: goal.id, dueAt: goal.dueAt },
        };
      },
    }),
    defineTool({
      name: "goal_list",
      label: "List Initiative Goals",
      description: "List the goals you set for yourself in this conversation.",
      parameters: Type.Object({}),
      exposure: "deferred",
      async execute() {
        const goals = (await coordinator.listGoals(channelId, accessScope)).filter((goal) =>
          isActiveGoal(goal),
        );
        return {
          content: [
            {
              type: "text",
              text:
                goals.length === 0
                  ? "この会話に自分で立てた Goal はありません。"
                  : goals.map((goal) => `${goal.id} ${formatGoal(goal)}`).join("\n"),
            },
          ],
          details: {
            goals: goals.map((goal) => ({
              id: goal.id,
              title: goal.title,
              status: goal.status,
              dueAt: goal.dueAt,
            })),
          },
        };
      },
    }),
    defineTool({
      name: "goal_dismiss",
      label: "Dismiss Initiative Goal",
      description:
        "Dismiss a goal you set for yourself in this conversation. Use goal_list to find its ID.",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const dismissed = await coordinator.dismissGoal(channelId, accessScope, params.id);
        return {
          content: [
            {
              type: "text",
              text: dismissed
                ? "Goal を取り下げました。"
                : "その Goal は見つからないか、取り下げできません。",
            },
          ],
          details: { id: params.id, dismissed },
        };
      },
    }),
  ];
}
