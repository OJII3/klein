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
      description: "List projects available to the coding harness.",
      promptSnippet: "List projects available for coding work.",
      promptGuidelines: [
        "Use this tool to discover projects allowed by Klein and pass their harness project ID to other coding tools.",
      ],
      parameters: Type.Object({}),
      async execute() {
        return jsonResult(await harness.listProjects());
      },
    }),
    defineTool({
      name: "coding_get_project_state",
      label: "Get coding project state",
      description: "Get a project's current coding activity and active runs.",
      promptSnippet: "Check the current coding activity for a project.",
      promptGuidelines: ["Use the project ID returned by coding_list_projects."],
      parameters: Type.Object({
        projectId: Type.String({ minLength: 1 }),
      }),
      async execute(_toolCallId, params) {
        return jsonResult(await harness.getProjectState(params.projectId as CodingProjectId));
      },
    }),
    defineTool({
      name: "coding_start_run",
      label: "Start coding run",
      description: "Ask the coding harness to work on a project task.",
      promptSnippet: "Delegate a project task to the coding harness.",
      promptGuidelines: [
        "Start a run only when the user has requested coding work.",
        "Reuse sessionId to continue an existing coding conversation when appropriate.",
        "Use the returned run ID to check progress with coding_get_run.",
      ],
      parameters: Type.Object({
        projectId: Type.String({ minLength: 1 }),
        prompt: Type.String({ minLength: 1 }),
        sessionId: Type.Optional(Type.String({ minLength: 1 })),
      }),
      async execute(_toolCallId, params) {
        return jsonResult(
          await harness.startRun({
            projectId: params.projectId as CodingProjectId,
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
