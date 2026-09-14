import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
} from "../../../modules/codex-app-server/infrastructure/codex-app-server-client.js";

export type CodexDelegateToolOptions = CodexAppServerClientOptions;

export function createCodexDelegateTool(options: CodexDelegateToolOptions) {
  return defineTool({
    name: "codex_delegate",
    label: "Delegate to Codex",
    description:
      "Ask the configured Codex app server to inspect, modify, test, or create files in its configured workspace.",
    promptSnippet: "Delegate code and workspace changes to the Codex app server.",
    promptGuidelines: [
      "Use codex_delegate for implementation, debugging, refactoring, tests, and prompt or skill edits in the configured workspace.",
      "Give codex_delegate a concrete goal, relevant constraints, and acceptance criteria; do not ask it to use a particular shell command unless that is part of the requirement.",
      "Treat codex_delegate's returned summary as the source of truth for what changed and what was verified.",
      "codex_delegate runs with workspace-write and approvalPolicy=never; do not use it for changes outside the configured workspace or for secrets.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      task: Type.String({
        minLength: 1,
        description: "The coding or workspace task to delegate to Codex.",
      }),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({
        content: [{ type: "text", text: "Codex app server に作業を委譲しています" }],
        details: {},
      });

      const client = new CodexAppServerClient(options);
      const result = await client.run(params.task, signal);
      return {
        content: [
          {
            type: "text",
            text: `Codex app server completed the task.\n\n${result.summary}`,
          },
        ],
        details: {
          threadId: result.threadId,
          turnId: result.turnId,
          status: result.status,
        },
      };
    },
  });
}

export type CodexDelegateTool = ReturnType<typeof createCodexDelegateTool>;
