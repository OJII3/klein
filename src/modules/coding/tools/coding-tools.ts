import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { CodingProjectId } from "../domain/coding-project";
import type { CodingHarness } from "../ports/coding-harness";

export const CODING_AGENT_TOOL_NAMES = [
  "coding_list_projects",
  "coding_get_project_state",
  "coding_start_run",
  "coding_get_run",
  "coding_cancel_run",
] as const;

const CodingProjectIdSchema = Type.String({
  minLength: 5,
  pattern: "^[^/]+/[^/]+/[^/]+$",
});

function asCodingProjectId(value: string): CodingProjectId {
  const parts = value.split("/");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error("Project ID must use host/owner/repo format");
  }

  return value as CodingProjectId;
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) ?? "null" }],
    details: { value },
  };
}

export function createCodingTools(harness: CodingHarness) {
  return [
    defineTool({
      name: "coding_list_projects",
      label: "List coding projects",
      description: "List repositories available to the coding harness.",
      promptSnippet: "List repositories available for coding work.",
      promptGuidelines: [
        "Use this tool to discover valid host/owner/repo project IDs before starting work.",
      ],
      parameters: Type.Object({}),
      async execute() {
        return jsonResult(await harness.listProjects());
      },
    }),
    defineTool({
      name: "coding_get_project_state",
      label: "Get coding project state",
      description: "Get a repository's current coding activity and active runs.",
      promptSnippet: "Check the current coding activity for a repository.",
      promptGuidelines: [
        "Use the canonical host/owner/repo repository ID, not a local filesystem path.",
      ],
      parameters: Type.Object({
        projectId: CodingProjectIdSchema,
      }),
      async execute(_toolCallId, params) {
        return jsonResult(await harness.getProjectState(asCodingProjectId(params.projectId)));
      },
    }),
    defineTool({
      name: "coding_start_run",
      label: "Start coding run",
      description: "Ask the coding harness to work on a repository task.",
      promptSnippet: "Delegate a repository task to the coding harness.",
      promptGuidelines: [
        "Start a run only when the user has requested coding work.",
        "Reuse sessionId to continue an existing coding conversation when appropriate.",
        "Use the returned run ID to check progress with coding_get_run.",
      ],
      parameters: Type.Object({
        projectId: CodingProjectIdSchema,
        prompt: Type.String({ minLength: 1 }),
        sessionId: Type.Optional(Type.String({ minLength: 1 })),
      }),
      async execute(_toolCallId, params) {
        return jsonResult(
          await harness.startRun({
            projectId: asCodingProjectId(params.projectId),
            prompt: params.prompt,
            sessionId: params.sessionId,
          }),
        );
      },
    }),
    defineTool({
      name: "coding_get_run",
      label: "Get coding run status",
      description: "Get the current state and result of a coding run.",
      promptSnippet: "Check a coding run's status and result.",
      promptGuidelines: [
        "Poll only when progress or the final result is needed; report waiting or failure states clearly.",
      ],
      parameters: Type.Object({
        runId: Type.String({ minLength: 1 }),
      }),
      async execute(_toolCallId, params) {
        return jsonResult(await harness.getRun(params.runId));
      },
    }),
    defineTool({
      name: "coding_cancel_run",
      label: "Cancel coding run",
      description: "Cancel an active coding run by its run ID.",
      promptSnippet: "Cancel an active coding run.",
      promptGuidelines: [
        "Cancel a run only when the user asks to stop it or the run is clearly unwanted.",
      ],
      parameters: Type.Object({
        runId: Type.String({ minLength: 1 }),
      }),
      async execute(_toolCallId, params) {
        await harness.cancelRun(params.runId);
        return jsonResult({ runId: params.runId, status: "cancelled" });
      },
    }),
  ];
}
