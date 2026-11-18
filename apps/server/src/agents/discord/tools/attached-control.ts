import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { AttachedTaskControl, AttachedTaskScope } from "@agents/core/attached-agent";
export function createAttachedControlTools(
  target: AttachedTaskControl,
  channelId: string,
  accessScope: string,
  ownerFeaturesAllowed: boolean,
) {
  const scope: AttachedTaskScope = {
    conversationKey: { kind: "discord", channelId },
    accessScope,
  };
  return [
    defineTool({
      name: "worker_start",
      label: "Start Worker",
      description:
        "Start a worker: a separate agent with its own session and tools. The worker cannot send Discord messages; its result arrives as an event. Use worker_send to give it follow-up instructions.",
      parameters: Type.Object({
        prompt: Type.String({ minLength: 1, maxLength: 4_000 }),
      }),
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const taskId = await target.start({
          ...scope,
          ownerFeaturesAllowed,
          prompt: params.prompt,
        });
        return {
          content: [
            {
              type: "text",
              text: `Started worker ${taskId}. Its result will arrive as an event.`,
            },
          ],
          details: { taskId },
        };
      },
    }),
    defineTool({
      name: "worker_send",
      label: "Send to Worker",
      description:
        "Send a follow-up instruction to a worker. The worker keeps its own session and returns another result.",
      parameters: Type.Object({
        taskId: Type.String({ minLength: 1 }),
        message: Type.String({ minLength: 1, maxLength: 4_000 }),
      }),
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const sent = await target.send(scope, params.taskId, params.message);
        return {
          content: [
            {
              type: "text",
              text: sent
                ? `Sent the follow-up to ${params.taskId}. Its next result will arrive as an event.`
                : `No worker ${params.taskId} is available.`,
            },
          ],
          details: { taskId: params.taskId, sent },
        };
      },
    }),
    defineTool({
      name: "worker_close",
      label: "Close Worker",
      description: "Close a worker and discard its session.",
      parameters: Type.Object({ taskId: Type.String({ minLength: 1 }) }),
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const closed = await target.close(scope, params.taskId);
        return {
          content: [
            {
              type: "text",
              text: closed
                ? `Closed worker ${params.taskId}.`
                : `No worker ${params.taskId} is available.`,
            },
          ],
          details: { taskId: params.taskId, closed },
        };
      },
    }),
    defineTool({
      name: "worker_list",
      label: "List Workers",
      description: "List workers in the current conversation.",
      parameters: Type.Object({}),
      exposure: "deferred",
      async execute() {
        const tasks = target.list(scope);
        return {
          content: [
            {
              type: "text",
              text:
                tasks.length === 0
                  ? "No workers in this conversation."
                  : tasks.map((task) => `- ${task.id} [${task.status}] ${task.prompt}`).join("\n"),
            },
          ],
          details: { tasks },
        };
      },
    }),
  ] as const;
}
