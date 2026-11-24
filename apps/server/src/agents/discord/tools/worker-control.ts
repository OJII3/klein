import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { WorkerControl, WorkerScope } from "@agents/core/worker-agent";
import { accessScopeUserId, type AccessScope } from "@shared/access";
export function createWorkerControlTools(
  target: WorkerControl,
  channelId: string,
  accessScope: AccessScope,
  ownerFeaturesAllowed: boolean,
  sessionFilePath?: () => string | undefined,
) {
  const scope: WorkerScope = {
    conversationKey: { kind: "discord", channelId },
    accessScope,
  };
  const workerCapabilities = [
    ...(accessScopeUserId(accessScope) !== undefined
      ? [
          "real browser use (agent-browser)",
          ownerFeaturesAllowed
            ? "an unsandboxed shell (bash) on the host"
            : "a sandboxed shell (bash)",
          "secret requests by direct message (secret_request, secret_list, secret_run, secret_delete)",
        ]
      : []),
    ...(ownerFeaturesAllowed
      ? ["T3 Code thread creation and follow-ups (t3_thread_start, t3_thread_send)"]
      : []),
  ];
  const capabilitiesNote =
    workerCapabilities.length > 0
      ? ` Workers in this conversation also have ${workerCapabilities.join(" and ")}, which you do not have directly.`
      : "";
  return [
    defineTool({
      name: "worker_start",
      label: "Start Worker",
      description:
        "Start a worker: a separate agent with its own persistent session and tools. The worker inherits this conversation's history up to this point, so give only the specific goal or next step instead of a self-contained brief. Prefer worker_start over doing multi-step web research, reading long pages or multiple sources, codemode/MCP workflows, or ongoing investigations inline in the conversation. The worker cannot send Discord messages and its result arrives as an event. Use worker_send for follow-ups." +
        capabilitiesNote,
      parameters: Type.Object({
        prompt: Type.String({
          minLength: 1,
          maxLength: 4_000,
          description:
            "The specific task for the worker. Do not repeat background, URLs, or message IDs that are already in this conversation.",
        }),
      }),
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const contextSessionFile = sessionFilePath?.();
        const workerId = await target.start({
          ...scope,
          ownerFeaturesAllowed,
          prompt: params.prompt,
          ...(contextSessionFile ? { contextSessionFile } : {}),
        });
        return {
          content: [
            {
              type: "text",
              text: `Started worker ${workerId}. Its result will arrive as an event.`,
            },
          ],
          details: { workerId },
        };
      },
    }),
    defineTool({
      name: "worker_send",
      label: "Send to Worker",
      description:
        "Send a short follow-up instruction to an existing worker. It resumes the worker's session, including the history it inherited when it started, and returns another result event; prefer reusing an existing worker for related follow-up work.",
      parameters: Type.Object({
        workerId: Type.String({ minLength: 1 }),
        message: Type.String({ minLength: 1, maxLength: 4_000 }),
      }),
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const sent = await target.send(scope, params.workerId, params.message);
        return {
          content: [
            {
              type: "text",
              text: sent
                ? `Sent the follow-up to ${params.workerId}. Its next result will arrive as an event.`
                : `No worker ${params.workerId} is available.`,
            },
          ],
          details: { workerId: params.workerId, sent },
        };
      },
    }),
    defineTool({
      name: "worker_close",
      label: "Close Worker",
      description: "Close a worker and discard its session.",
      parameters: Type.Object({ workerId: Type.String({ minLength: 1 }) }),
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const closed = await target.close(scope, params.workerId);
        return {
          content: [
            {
              type: "text",
              text: closed
                ? `Closed worker ${params.workerId}.`
                : `No worker ${params.workerId} is available.`,
            },
          ],
          details: { workerId: params.workerId, closed },
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
        const workers = target.list(scope);
        return {
          content: [
            {
              type: "text",
              text:
                workers.length === 0
                  ? "No workers in this conversation."
                  : workers
                      .map((worker) => `- ${worker.id} [${worker.status}] ${worker.prompt}`)
                      .join("\n"),
            },
          ],
          details: { workers },
        };
      },
    }),
  ] as const;
}
