import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { CodingBackendRegistry } from "@modules/coding/application/coding-backend-registry";
import type { CodingBackend } from "@modules/coding/ports/coding-backend";
import {
  formatCodingSessionRef,
  isCodingSessionWaiting,
  type CodingSessionRun,
  type CodingSessionSummary,
  type CodingSessionWaitResult,
} from "@modules/coding/domain/coding-session";

const MAX_MESSAGE_LENGTH = 8_000;
const MAX_PROJECT_LENGTH = 1_000;
const MAX_SESSION_REF_LENGTH = 500;
const MAX_TITLE_LENGTH = 200;
const MAX_LISTED_SESSIONS = 50;
const MAX_TOOL_OUTPUT_CHARS = 20_000;
const DEFAULT_WAIT_SECONDS = 300;
const MAX_WAIT_SECONDS = 1_800;

export function createCodingSessionTools(
  registry: CodingBackendRegistry,
): readonly ToolDefinition[] {
  const backendSchema = Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 100,
      description: `Coding backend id. Defaults to "${registry.defaultId}". Use coding_backend_list to see the available backends.`,
    }),
  );
  const sessionSchema = Type.String({
    minLength: 1,
    maxLength: MAX_SESSION_REF_LENGTH,
    description: "Session reference returned by coding_session_start or coding_session_list.",
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
      name: "coding_session_start",
      label: "Start Coding Session",
      description:
        "Start a coding session: a persistent agent session for repository work such as code edits, tests, builds, commits, branches, and pull requests. " +
        "Use one session per independent workstream. The session runs with the backend's default provider, model, and permissions. " +
        "By default this waits for the run to finish and includes the reply; set wait to false to return as soon as the session starts.",
      promptSnippet:
        "Delegate repository work to a coding session; coding_session_start returns the session's reply.",
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
      name: "coding_session_send",
      label: "Send to Coding Session",
      description:
        "Send a follow-up message to a coding session and return its result. " +
        "Use the same session for iteration instead of starting a new one. By default this waits for the run to finish and includes the reply.",
      promptSnippet: "Send a follow-up to a coding session and return its reply.",
      parameters: Type.Object({
        session: sessionSchema,
        message: Type.String({ minLength: 1, maxLength: MAX_MESSAGE_LENGTH }),
        wait: Type.Optional(
          Type.Boolean({
            default: true,
            description: "Wait for the run to finish and include its reply. Defaults to true.",
          }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        const { backend, sessionId } = registry.resolve(params.session);
        const result = await backend.send(
          { sessionId, message: params.message, wait: params.wait ?? true },
          signal,
        );
        return {
          content: [{ type: "text", text: formatRun("Sent to", backend.id, result) }],
          details: { backend: backend.id, ...result },
        };
      },
    }),
    defineTool({
      name: "coding_session_wait",
      label: "Wait for Coding Session",
      description:
        "Wait for a coding session's latest run to finish or ask for input, polling its state. " +
        "Returns the session state and latest messages. Use this after starting with wait set to false, or to follow a session started in an earlier turn. " +
        "When the timeout expires it returns timedOut with the current state; call it again to keep waiting.",
      promptSnippet: "Wait for a coding session to finish or ask for input.",
      parameters: Type.Object({
        session: sessionSchema,
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
        const { backend, sessionId } = registry.resolve(params.session);
        const result = await backend.wait(
          {
            sessionId,
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
      name: "coding_session_show",
      label: "Show Coding Session",
      description:
        "Show a coding session's status, link, branch, pull request, pending questions, and latest messages. " +
        "Use this to check a session started with wait set to false, or to read a question when a run reports waiting.",
      promptSnippet: "Read a coding session's status and latest messages.",
      parameters: Type.Object({
        session: sessionSchema,
        messages: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 50, default: 10, description: "Defaults to 10." }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        const { backend, sessionId } = registry.resolve(params.session);
        const detail = await backend.show(sessionId, params.messages ?? 10, signal);
        return {
          content: [
            { type: "text", text: formatDetail(backend.id, detail.session, detail.messages) },
          ],
          details: { backend: backend.id, ...detail },
        };
      },
    }),
    defineTool({
      name: "coding_session_list",
      label: "List Coding Sessions",
      description: "List coding sessions in a project, newest first.",
      promptSnippet: "List coding sessions in a project.",
      parameters: Type.Object({ backend: backendSchema, project: projectSchema }),
      async execute(_toolCallId, params, signal) {
        const backend = registry.get(params.backend);
        const sessions = await backend.list(params.project, signal);
        return {
          content: [{ type: "text", text: formatSessionList(backend.id, sessions) }],
          details: { backend: backend.id, sessions },
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

function formatRun(
  verb: "Started" | "Sent to",
  backendId: string,
  result: CodingSessionRun,
): string {
  const ref = formatCodingSessionRef(backendId, result.sessionId);
  const lines = [`${verb} coding session ${ref} (${result.status}).`];
  if (result.link) lines.push(result.link);
  if (result.error) lines.push(`Error: ${result.error}`);
  if (result.reply) lines.push("", result.reply);
  if (result.status === "waiting") {
    lines.push(
      "",
      "The session is waiting for an answer. Read the question with coding_session_show, answer it with coding_session_send, or report the question.",
    );
  } else if (!result.error && !result.reply && result.status === "running") {
    lines.push(
      "",
      "The session is still running; use coding_session_show to check its status, link, and pull request, or coding_session_wait to wait for it.",
    );
  }
  return limitOutput(lines.join("\n"));
}

function formatWait(
  backendId: string,
  result: CodingSessionWaitResult,
  timeoutSeconds: number,
): string {
  const { session, timedOut } = result;
  const ref = formatCodingSessionRef(backendId, session.id);
  const headline = timedOut
    ? `Coding session ${ref} is still ${session.status} after ${timeoutSeconds}s. Call coding_session_wait again to keep waiting.`
    : isCodingSessionWaiting(session)
      ? `Coding session ${ref} is waiting for an answer. Read the question, then answer it with coding_session_send.`
      : `Coding session ${ref} finished (${session.status}).`;
  return limitOutput([headline, "", ...detailLines(ref, session, result.messages)].join("\n"));
}

function formatDetail(
  backendId: string,
  session: CodingSessionSummary,
  messages: readonly { readonly role: string; readonly text: string }[],
): string {
  const ref = formatCodingSessionRef(backendId, session.id);
  return limitOutput(detailLines(ref, session, messages).join("\n"));
}

function detailLines(
  ref: string,
  session: CodingSessionSummary,
  messages: readonly { readonly role: string; readonly text: string }[],
): string[] {
  const lines = [`${session.title || "(untitled)"} — ${ref} (${session.status})`];
  if (session.link) lines.push(session.link);
  if (session.branch || session.worktreePath) {
    lines.push(
      `branch: ${session.branch ?? "(detached)"}${
        session.worktreePath ? ` (worktree ${session.worktreePath})` : ""
      }`,
    );
  }
  if (session.pendingQuestionCount && session.pendingQuestionCount > 0) {
    lines.push(`Waiting for ${session.pendingQuestionCount} answer(s).`);
  }
  if (session.pullRequest) {
    lines.push(`PR: ${session.pullRequest.url}`);
  } else if (session.pullRequestCount && session.pullRequestCount > 0) {
    lines.push(`PRs: ${session.pullRequestCount} (${session.openPullRequestCount ?? 0} open)`);
  }
  for (const message of messages) {
    lines.push("", `[${message.role}]`, message.text);
  }
  return lines;
}

function formatSessionList(backendId: string, sessions: readonly CodingSessionSummary[]): string {
  if (sessions.length === 0) return "No coding sessions in this project.";
  return limitOutput(
    sessions
      .slice(0, MAX_LISTED_SESSIONS)
      .map((session) => formatSessionLine(backendId, session))
      .join("\n"),
  );
}

function formatSessionLine(backendId: string, session: CodingSessionSummary): string {
  const notes: string[] = [];
  if (session.pendingQuestionCount && session.pendingQuestionCount > 0) {
    notes.push(`waiting ${session.pendingQuestionCount}`);
  }
  if (session.openPullRequestCount && session.openPullRequestCount > 0) {
    notes.push(`${session.openPullRequestCount} open PR`);
  }
  const suffix = notes.length > 0 ? `  [${notes.join(", ")}]` : "";
  const ref = formatCodingSessionRef(backendId, session.id);
  return `- ${ref}  ${session.status}  ${session.title || "(untitled)"}${suffix}`;
}

function limitOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… (truncated)`;
}
