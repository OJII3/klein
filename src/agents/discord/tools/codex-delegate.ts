import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  CodexDelegationService,
  type CodexDelegationServiceOptions,
  type CodexTask,
} from "../../../modules/codex-app-server/application/codex-delegation-service.js";

export type CodexTools = readonly [
  ReturnType<typeof createCodexProjectsTool>,
  ReturnType<typeof createCodexDelegateTool>,
  ReturnType<typeof createCodexTaskStatusTool>,
];

type CodexTaskStatusDetails = CodexTask | { readonly taskId: string; readonly status: "not_found" };
type CodexTaskStatusResult = {
  readonly content: [{ readonly type: "text"; readonly text: string }];
  readonly details: CodexTaskStatusDetails;
};

export function createCodexTools(options: CodexDelegationServiceOptions): CodexTools {
  const service = new CodexDelegationService(options);
  return [
    createCodexProjectsTool(service),
    createCodexDelegateTool(service),
    createCodexTaskStatusTool(service),
  ];
}

export function createCodexProjectsTool(service: Pick<CodexDelegationService, "listProjects">) {
  return defineTool({
    name: "codex_projects",
    label: "List Codex projects",
    description: "List project directories that the Codex app server can use.",
    promptSnippet: "List available Codex projects.",
    promptGuidelines: [
      "Use codex_projects before delegating when the user did not specify which project to change.",
      "Choose a project path from the returned list and pass it to codex_delegate.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const projects = await service.listProjects();
      return {
        content: [
          {
            type: "text" as const,
            text:
              projects.length === 0
                ? "利用可能な Codex project はありません。"
                : projects
                    .map(
                      (project) =>
                        `- ${project.id}${project.isDefault ? " (default)" : ""}: ${project.path}`,
                    )
                    .join("\n"),
          },
        ],
        details: { projects },
      };
    },
  });
}

export function createCodexDelegateTool(service: Pick<CodexDelegationService, "submit">) {
  return defineTool({
    name: "codex_delegate",
    label: "Delegate to Codex",
    description:
      "Start a background task on the Codex app server to inspect, modify, test, or create files.",
    promptSnippet: "Start a background code task with Codex.",
    promptGuidelines: [
      "Use codex_delegate for implementation, debugging, refactoring, tests, and prompt or skill edits in the configured workspace.",
      "Give codex_delegate a concrete goal, relevant constraints, and acceptance criteria; do not ask it to use a particular shell command unless that is part of the requirement.",
      "codex_delegate returns immediately and posts its acceptance to Discord; do not call discord_send just to acknowledge this task.",
      "Use codex_projects first when a project is not clear, then pass its path as project.",
      "codex_delegate runs with workspace-write and approvalPolicy=never; do not use it for changes outside a Codex project or for secrets.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      task: Type.String({
        minLength: 1,
        description: "The coding or workspace task to delegate to Codex.",
      }),
      project: Type.Optional(
        Type.String({
          minLength: 1,
          description: "Project path from codex_projects. Omit to use the default project.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const task = await service.submit(params.task, params.project);
      return {
        content: [
          {
            type: "text",
            text:
              `Codex task accepted for background execution.\n` +
              `task: ${task.id}\n` +
              `project: ${task.project.name}\n` +
              "Completion or failure will be posted to the current Discord channel.",
          },
        ],
        details: {
          taskId: task.id,
          project: task.project,
          status: task.status,
        },
      };
    },
  });
}

export function createCodexTaskStatusTool(service: Pick<CodexDelegationService, "getStatus">) {
  return defineTool({
    name: "codex_task_status",
    label: "Get Codex task status",
    description: "Get the current status and latest result of a background Codex task.",
    promptSnippet: "Check a background Codex task.",
    parameters: Type.Object({
      taskId: Type.String({ minLength: 1, description: "The task id returned by codex_delegate." }),
    }),
    async execute(_toolCallId, params) {
      const task = service.getStatus(params.taskId);
      return task ? taskResult(task) : taskNotFound(params.taskId);
    },
  });
}

function taskResult(task: CodexTask): CodexTaskStatusResult {
  return {
    content: [
      {
        type: "text" as const,
        text: [
          `task: ${task.id}`,
          `project: ${task.project.name}`,
          `status: ${task.status}`,
          task.result ? `summary: ${task.result.summary}` : undefined,
          task.error ? `error: ${task.error}` : undefined,
        ]
          .filter((line): line is string => line !== undefined)
          .join("\n"),
      },
    ],
    details: task,
  };
}

function taskNotFound(taskId: string): CodexTaskStatusResult {
  return {
    content: [{ type: "text" as const, text: `Codex task was not found: ${taskId}` }],
    details: { taskId, status: "not_found" as const },
  };
}

export type CodexDelegateTool = ReturnType<typeof createCodexDelegateTool>;
