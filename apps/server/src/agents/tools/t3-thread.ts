import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_MESSAGE_LENGTH = 8_000;
const MAX_PROJECT_LENGTH = 1_000;
const MAX_THREAD_ID_LENGTH = 200;
const MAX_TITLE_LENGTH = 200;
const MAX_LISTED_THREADS = 50;
const MAX_TOOL_OUTPUT_CHARS = 20_000;

export interface T3ThreadMessage {
  readonly role: string;
  readonly text: string;
}

export interface T3ThreadSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly link?: string;
  readonly updatedAt?: string;
}

export interface T3ThreadRun {
  readonly threadId: string;
  readonly status: string;
  readonly reply?: string;
  readonly error?: string;
}

export interface T3ThreadDetail {
  readonly thread: T3ThreadSummary;
  readonly messages: readonly T3ThreadMessage[];
}

export interface T3ThreadStartInput {
  readonly project?: string;
  readonly message: string;
  readonly title?: string;
  readonly wait: boolean;
  readonly worktree?: string;
  readonly branch?: string;
}

export interface T3ThreadSendInput {
  readonly threadId: string;
  readonly message: string;
  readonly wait: boolean;
}

/**
 * T3 Code の `t3 thread` サブコマンドを包む。ワーカーはこの境界だけを通して
 * T3 Code のスレッドを操作し、CLI の引数や出力形式をツール側へ漏らさない。
 */
export interface T3ThreadRunner {
  list(project: string | undefined, signal?: AbortSignal): Promise<readonly T3ThreadSummary[]>;
  start(input: T3ThreadStartInput, signal?: AbortSignal): Promise<T3ThreadRun>;
  send(input: T3ThreadSendInput, signal?: AbortSignal): Promise<T3ThreadRun>;
  show(threadId: string, messages: number, signal?: AbortSignal): Promise<T3ThreadDetail>;
}

const projectSchema = Type.Optional(
  Type.String({
    minLength: 1,
    maxLength: MAX_PROJECT_LENGTH,
    description:
      "T3 Code project id, or a path inside the project. Defaults to Klein's working directory.",
  }),
);

export function createT3ThreadTools(runner: T3ThreadRunner): readonly ToolDefinition[] {
  return [
    defineTool({
      name: "t3_thread_start",
      label: "Start T3 Thread",
      description:
        "Start a T3 Code thread in a project and return its result. Use this to delegate coding work to a T3 Code agent. " +
        "The thread runs with the project's default provider, model, and permissions. " +
        "By default this waits for the run to finish and includes the reply; set wait to false to return as soon as the thread starts.",
      promptSnippet:
        "Delegate coding work to a T3 Code thread; t3_thread_start returns the thread's reply.",
      parameters: Type.Object({
        message: Type.String({
          minLength: 1,
          maxLength: MAX_MESSAGE_LENGTH,
          description: "A self-contained task for the T3 Code thread.",
        }),
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
          Type.String({ minLength: 1, description: "Branch name for the new worktree." }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        const result = await runner.start(
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
          content: [{ type: "text", text: formatRun("Started", result) }],
          details: result,
        };
      },
    }),
    defineTool({
      name: "t3_thread_send",
      label: "Send to T3 Thread",
      description:
        "Send a follow-up message to a T3 Code thread and return its result. " +
        "By default this waits for the run to finish and includes the reply.",
      promptSnippet: "Send a follow-up to a T3 Code thread and return its reply.",
      parameters: Type.Object({
        threadId: Type.String({ minLength: 1, maxLength: MAX_THREAD_ID_LENGTH }),
        message: Type.String({ minLength: 1, maxLength: MAX_MESSAGE_LENGTH }),
        wait: Type.Optional(
          Type.Boolean({
            default: true,
            description: "Wait for the run to finish and include its reply. Defaults to true.",
          }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        const result = await runner.send(
          { threadId: params.threadId, message: params.message, wait: params.wait ?? true },
          signal,
        );
        return {
          content: [{ type: "text", text: formatRun("Sent to", result) }],
          details: result,
        };
      },
    }),
    defineTool({
      name: "t3_thread_show",
      label: "Show T3 Thread",
      description:
        "Show a T3 Code thread's status, link, and latest messages. " +
        "Use this to check a thread started with wait set to false.",
      promptSnippet: "Read a T3 Code thread's status and latest messages.",
      parameters: Type.Object({
        threadId: Type.String({ minLength: 1, maxLength: MAX_THREAD_ID_LENGTH }),
        messages: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 50, default: 10, description: "Defaults to 10." }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        const detail = await runner.show(params.threadId, params.messages ?? 10, signal);
        return {
          content: [{ type: "text", text: formatDetail(detail) }],
          details: detail,
        };
      },
    }),
    defineTool({
      name: "t3_thread_list",
      label: "List T3 Threads",
      description:
        "List T3 Code threads in a project, newest first. Threads include the owner's own threads.",
      promptSnippet: "List T3 Code threads in a project.",
      parameters: Type.Object({ project: projectSchema }),
      async execute(_toolCallId, params, signal) {
        const threads = await runner.list(params.project, signal);
        return {
          content: [{ type: "text", text: formatThreadList(threads) }],
          details: { threads },
        };
      },
    }),
  ] as const;
}

function formatRun(verb: "Started" | "Sent to", result: T3ThreadRun): string {
  const lines = [`${verb} T3 thread ${result.threadId} (${result.status}).`];
  if (result.error) lines.push(`Error: ${result.error}`);
  if (result.reply) lines.push("", result.reply);
  if (!result.error && !result.reply && result.status !== "completed") {
    lines.push("The thread is still running; use t3_thread_show to check it.");
  }
  return limitOutput(lines.join("\n"));
}

function formatDetail(detail: T3ThreadDetail): string {
  const { thread, messages } = detail;
  const lines = [`${thread.title || "(untitled)"} — ${thread.id} (${thread.status})`];
  if (thread.link) lines.push(thread.link);
  for (const message of messages) {
    lines.push("", `[${message.role}]`, message.text);
  }
  return limitOutput(lines.join("\n"));
}

function formatThreadList(threads: readonly T3ThreadSummary[]): string {
  if (threads.length === 0) return "No T3 Code threads in this project.";
  return limitOutput(
    threads
      .slice(0, MAX_LISTED_THREADS)
      .map((thread) => `- ${thread.id}  ${thread.status}  ${thread.title || "(untitled)"}`)
      .join("\n"),
  );
}

function limitOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… (truncated)`;
}
