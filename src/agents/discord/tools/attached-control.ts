import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { AttachedTaskControl } from "@agents/core/attached-agent";

/**
 * Conversation-side controls for attached tasks. The attached agent itself
 * does not see these tools; it only receives the prompts and returns results.
 */
export function createAttachedControlTools(
  target: AttachedTaskControl,
  channelId: string,
  accessScope: string,
  ownerFeaturesAllowed: boolean,
) {
  return [
    defineTool({
      name: "attached_start",
      label: "Start Attached Task",
      description:
        "Start an attached task in its own session. The task cannot send Discord messages; its result arrives as an event. Use attached_send to give it follow-up instructions.",
      parameters: Type.Object({
        prompt: Type.String({ minLength: 1, maxLength: 4_000 }),
      }),
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const taskId = await target.start({
          channelId,
          accessScope,
          ownerFeaturesAllowed,
          prompt: params.prompt,
        });
        return {
          content: [
            {
              type: "text",
              text: `Started attached task ${taskId}. Its result will arrive as an event.`,
            },
          ],
          details: { taskId },
        };
      },
    }),
    defineTool({
      name: "attached_send",
      label: "Send to Attached Task",
      description:
        "Send a follow-up instruction to an attached task. The task keeps its own session and returns another result.",
      parameters: Type.Object({
        taskId: Type.String({ minLength: 1 }),
        message: Type.String({ minLength: 1, maxLength: 4_000 }),
      }),
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const sent = await target.send(params.taskId, params.message);
        return {
          content: [
            {
              type: "text",
              text: sent
                ? `Sent the follow-up to ${params.taskId}. Its next result will arrive as an event.`
                : `No attached task ${params.taskId} is available.`,
            },
          ],
          details: { taskId: params.taskId, sent },
        };
      },
    }),
    defineTool({
      name: "attached_close",
      label: "Close Attached Task",
      description: "Close an attached task and discard its session.",
      parameters: Type.Object({ taskId: Type.String({ minLength: 1 }) }),
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const closed = await target.close(params.taskId);
        return {
          content: [
            {
              type: "text",
              text: closed
                ? `Closed attached task ${params.taskId}.`
                : `No attached task ${params.taskId} is available.`,
            },
          ],
          details: { taskId: params.taskId, closed },
        };
      },
    }),
    defineTool({
      name: "attached_list",
      label: "List Attached Tasks",
      description: "List attached tasks in the current conversation.",
      parameters: Type.Object({}),
      exposure: "deferred",
      async execute() {
        const tasks = target.list(channelId);
        return {
          content: [
            {
              type: "text",
              text:
                tasks.length === 0
                  ? "No attached tasks in this conversation."
                  : tasks.map((task) => `- ${task.id} [${task.status}] ${task.prompt}`).join("\n"),
            },
          ],
          details: { tasks },
        };
      },
    }),
  ];
}
