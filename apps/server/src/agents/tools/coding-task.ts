import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { CodingBackendRegistry } from "@modules/coding/application/coding-backend-registry";
import type { CodingBackend } from "@modules/coding/ports/coding-backend";
import {
  formatCodingTaskRef,
  isCodingTaskWaiting,
  type CodingTaskRun,
  type CodingTaskSummary,
  type CodingTaskWaitResult,
} from "@modules/coding/domain/coding-task";

const MAX_MESSAGE_LENGTH = 8_000;
const MAX_PROJECT_LENGTH = 1_000;
const MAX_TASK_REF_LENGTH = 500;
const MAX_TITLE_LENGTH = 200;
const MAX_LISTED_TASKS = 50;
const MAX_TOOL_OUTPUT_CHARS = 20_000;
const DEFAULT_WAIT_SECONDS = 300;
const MAX_WAIT_SECONDS = 1_800;

export function createCodingTaskTools(registry: CodingBackendRegistry): readonly ToolDefinition[] {
  const backendSchema = Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 100,
      description: `Coding backend id. Defaults to "${registry.defaultId}". Use coding_backend_list to see the available backends.`,
    }),
  );
  const taskSchema = Type.String({
    minLength: 1,
    maxLength: MAX_TASK_REF_LENGTH,
    description: "Task reference returned by coding_task_start or coding_task_list.",
  });
  const projectSchema = Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: MAX_PROJECT_LENGTH,
      description:
        "Project id, or a path inside the project. Defaults to the backend's current project.",
    }),
  );

  return [
    defineTool({
      name: "coding_backend_list",
      label: "List Coding Backends",
      description:
        "List the coding backends available for repository work, their ids, and what each supports.",
      promptSnippet: "List coding backends and their capabilities.",
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [{ type: "text", text: formatBackends(registry) }],
          details: {
            default: registry.defaultId,
            backends: registry.list().map((backend) => ({
              id: backend.id,
              label: backend.label,
              capabilities: backend.capabilities,
            })),
          },
        };
      },
    }),
    defineTool({
      name: "coding_task_start",
      label: "Start Coding Task",
      description:
        "Start a coding task: a persistent session with a coding agent for repository work such as code edits, tests, builds, commits, branches, and pull requests. " +
        "Use one task per independent workstream. The task runs with the backend's default provider, model, and permissions. " +
        "By default this waits for the run to finish and includes the reply; set wait to false to return as soon as the task starts.",
      promptSnippet:
        "Delegate repository work to a coding task; coding_task_start returns the task's reply.",
      parameters: Type.Object({
        message: Type.String({
          minLength: 1,
          maxLength: MAX_MESSAGE_LENGTH,
          description:
            "A self-contained task for the coding agent. Include the goal, repository, acceptance checks, and constraints.",
        }),
        backend: backendSchema,
        title: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TITLE_LENGTH })),
        project: projectSchema,
        wait: Type.Optional(
          Type.Boolean({
            default: true,
            description: "Wait for the run to finish and include its reply. Defaults to true.",
          }),
        ),
        worktree: Type.Optional(
          Type.String({
            minLength: 1,
            description: "Run in a new git worktree based on this branch, tag, or commit.",
          }),
        ),
        branch: Type.Optional(
          Type.String({
            minLength: 1,
            description: "Branch name for the new worktree. Needs worktree.",
          }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        if (params.branch && !params.worktree) {
          throw new Error("`branch` needs `worktree`. Pass the base branch, tag, or commit too.");
        }
        const backend = registry.get(params.backend);
        if ((params.worktree || params.branch) && !backend.capabilities.worktree) {
          throw new Error(`Coding backend "${backend.id}" does not support worktrees.`);
        }
        const result = await backend.start(
          {
            ...(params.project ? { project: params.project } : {}),
            message: params.message,
            ...(params.title ? { title: params.title } : {}),
            wait: params.wait ?? true,
            ...(params.worktree ? { worktree: params.worktree } : {}),
            ...(params.branch ? { branch: params.branch } : {}),
          },
          signal,
        );
        return {
          content: [{ type: "text", text: formatRun("Started", backend.id, result) }],
          details: { backend: backend.id, ...result },
        };
      },
    }),
    defineTool({
      name: "coding_task_send",
      label: "Send to Coding Task",
      description:
        "Send a follow-up message to a coding task and return its result. " +
        "Use the same task for iteration instead of starting a new one. By default this waits for the run to finish and includes the reply.",
      promptSnippet: "Send a follow-up to a coding task and return its reply.",
      parameters: Type.Object({
        task: taskSchema,
        message: Type.String({ minLength: 1, maxLength: MAX_MESSAGE_LENGTH }),
        wait: Type.Optional(
          Type.Boolean({
            default: true,
            description: "Wait for the run to finish and include its reply. Defaults to true.",
          }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        const { backend, taskId } = registry.resolve(params.task);
        const result = await backend.send(
          { taskId, message: params.message, wait: params.wait ?? true },
          signal,
        );
        return {
          content: [{ type: "text", text: formatRun("Sent to", backend.id, result) }],
          details: { backend: backend.id, ...result },
        };
      },
    }),
    defineTool({
      name: "coding_task_wait",
      label: "Wait for Coding Task",
      description:
        "Wait for a coding task's latest run to finish or ask for input, polling its state. " +
        "Returns the task state and latest messages. Use this after starting with wait set to false, or to follow a task from an earlier session. " +
        "When the timeout expires it returns timedOut with the current state; call it again to keep waiting.",
      promptSnippet: "Wait for a coding task to finish or ask for input.",
      parameters: Type.Object({
        task: taskSchema,
        timeoutSeconds: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: MAX_WAIT_SECONDS,
            default: DEFAULT_WAIT_SECONDS,
            description: `Defaults to ${DEFAULT_WAIT_SECONDS} seconds. Max ${MAX_WAIT_SECONDS}.`,
          }),
        ),
        messages: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 50, default: 10, description: "Defaults to 10." }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        const timeoutSeconds = params.timeoutSeconds ?? DEFAULT_WAIT_SECONDS;
        const { backend, taskId } = registry.resolve(params.task);
        const result = await backend.wait(
          {
            taskId,
            messages: params.messages ?? 10,
            timeoutMs: timeoutSeconds * 1_000,
          },
          signal,
        );
        return {
          content: [{ type: "text", text: formatWait(backend.id, result, timeoutSeconds) }],
          details: { backend: backend.id, ...result },
        };
      },
    }),
    defineTool({
      name: "coding_task_show",
      label: "Show Coding Task",
      description:
        "Show a coding task's status, link, branch, pull request, pending questions, and latest messages. " +
        "Use this to check a task started with wait set to false, or to read a question when a run reports waiting.",
      promptSnippet: "Read a coding task's status and latest messages.",
      parameters: Type.Object({
        task: taskSchema,
        messages: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 50, default: 10, description: "Defaults to 10." }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        const { backend, taskId } = registry.resolve(params.task);
        const detail = await backend.show(taskId, params.messages ?? 10, signal);
        return {
          content: [{ type: "text", text: formatDetail(backend.id, detail.task, detail.messages) }],
          details: { backend: backend.id, ...detail },
        };
      },
    }),
    defineTool({
      name: "coding_task_list",
      label: "List Coding Tasks",
      description: "List coding tasks in a project, newest first.",
      promptSnippet: "List coding tasks in a project.",
      parameters: Type.Object({ backend: backendSchema, project: projectSchema }),
      async execute(_toolCallId, params, signal) {
        const backend = registry.get(params.backend);
        const tasks = await backend.list(params.project, signal);
        return {
          content: [{ type: "text", text: formatTaskList(backend.id, tasks) }],
          details: { backend: backend.id, tasks },
        };
      },
    }),
  ] as const;
}

function formatBackends(registry: CodingBackendRegistry): string {
  return registry
    .list()
    .map((backend) => {
      const notes = capabilityNotes(backend);
      const suffix = notes.length > 0 ? ` (${notes.join(", ")})` : "";
      const isDefault = backend.id === registry.defaultId ? " — default" : "";
      return `- ${backend.id}: ${backend.label}${suffix}${isDefault}`;
    })
    .join("\n");
}

function capabilityNotes(backend: CodingBackend): string[] {
  return [
    ...(backend.capabilities.projects ? ["projects"] : []),
    ...(backend.capabilities.worktree ? ["worktrees"] : []),
    ...(backend.capabilities.pullRequest ? ["pull requests"] : []),
    ...(backend.capabilities.questions ? ["questions"] : []),
  ];
}

function formatRun(verb: "Started" | "Sent to", backendId: string, result: CodingTaskRun): string {
  const ref = formatCodingTaskRef(backendId, result.taskId);
  const lines = [`${verb} coding task ${ref} (${result.status}).`];
  if (result.link) lines.push(result.link);
  if (result.error) lines.push(`Error: ${result.error}`);
  if (result.reply) lines.push("", result.reply);
  if (result.status === "waiting") {
    lines.push(
      "",
      "The task is waiting for an answer. Read the question with coding_task_show, answer it with coding_task_send, or report the question.",
    );
  } else if (!result.error && !result.reply && result.status === "running") {
    lines.push(
      "",
      "The task is still running; use coding_task_show to check its status, link, and pull request, or coding_task_wait to wait for it.",
    );
  }
  return limitOutput(lines.join("\n"));
}

function formatWait(
  backendId: string,
  result: CodingTaskWaitResult,
  timeoutSeconds: number,
): string {
  const { task, timedOut } = result;
  const ref = formatCodingTaskRef(backendId, task.id);
  const headline = timedOut
    ? `Coding task ${ref} is still ${task.status} after ${timeoutSeconds}s. Call coding_task_wait again to keep waiting.`
    : isCodingTaskWaiting(task)
      ? `Coding task ${ref} is waiting for an answer. Read the question, then answer it with coding_task_send.`
      : `Coding task ${ref} finished (${task.status}).`;
  return limitOutput([headline, "", ...detailLines(ref, task, result.messages)].join("\n"));
}

function formatDetail(
  backendId: string,
  task: CodingTaskSummary,
  messages: readonly { readonly role: string; readonly text: string }[],
): string {
  const ref = formatCodingTaskRef(backendId, task.id);
  return limitOutput(detailLines(ref, task, messages).join("\n"));
}

function detailLines(
  ref: string,
  task: CodingTaskSummary,
  messages: readonly { readonly role: string; readonly text: string }[],
): string[] {
  const lines = [`${task.title || "(untitled)"} — ${ref} (${task.status})`];
  if (task.link) lines.push(task.link);
  if (task.branch || task.worktreePath) {
    lines.push(
      `branch: ${task.branch ?? "(detached)"}${
        task.worktreePath ? ` (worktree ${task.worktreePath})` : ""
      }`,
    );
  }
  if (task.pendingQuestionCount && task.pendingQuestionCount > 0) {
    lines.push(`Waiting for ${task.pendingQuestionCount} answer(s).`);
  }
  if (task.pullRequest) {
    lines.push(`PR: ${task.pullRequest.url}`);
  } else if (task.pullRequestCount && task.pullRequestCount > 0) {
    lines.push(`PRs: ${task.pullRequestCount} (${task.openPullRequestCount ?? 0} open)`);
  }
  for (const message of messages) {
    lines.push("", `[${message.role}]`, message.text);
  }
  return lines;
}

function formatTaskList(backendId: string, tasks: readonly CodingTaskSummary[]): string {
  if (tasks.length === 0) return "No coding tasks in this project.";
  return limitOutput(
    tasks
      .slice(0, MAX_LISTED_TASKS)
      .map((task) => formatTaskLine(backendId, task))
      .join("\n"),
  );
}

function formatTaskLine(backendId: string, task: CodingTaskSummary): string {
  const notes: string[] = [];
  if (task.pendingQuestionCount && task.pendingQuestionCount > 0) {
    notes.push(`waiting ${task.pendingQuestionCount}`);
  }
  if (task.openPullRequestCount && task.openPullRequestCount > 0) {
    notes.push(`${task.openPullRequestCount} open PR`);
  }
  const suffix = notes.length > 0 ? `  [${notes.join(", ")}]` : "";
  const ref = formatCodingTaskRef(backendId, task.id);
  return `- ${ref}  ${task.status}  ${task.title || "(untitled)"}${suffix}`;
}

function limitOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… (truncated)`;
}
