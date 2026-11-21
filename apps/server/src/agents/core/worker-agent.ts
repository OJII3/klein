import type { AccessScope } from "@shared/access";
import type { ConversationKey } from "@shared/conversation-key";

/**
 * `interrupted` marks a worker whose prompt was still running when the process
 * stopped. The worker is restored, but its prompt is not re-run automatically.
 */
export type WorkerStatus = "running" | "idle" | "failed" | "interrupted";

export interface WorkerInfo {
  readonly id: string;
  readonly prompt: string;
  readonly status: WorkerStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkerResult {
  readonly workerId: string;
  readonly status: "completed" | "failed";
  /** The worker's assistant text, or a placeholder when it produced none. */
  readonly text: string;
  readonly error?: string;
}

export interface WorkerScope {
  readonly conversationKey: ConversationKey;
  readonly accessScope: AccessScope;
}

export interface WorkerStartInput extends WorkerScope {
  readonly ownerFeaturesAllowed: boolean;
  readonly prompt: string;
  /**
   * Closes the worker after its result is delivered. Use this for a worker that
   * exists only to produce one result, such as a reminder.
   */
  readonly closeAfterResult?: boolean;
}
export interface WorkerControl {
  start(input: WorkerStartInput): Promise<string>;
  send(scope: WorkerScope, workerId: string, message: string): Promise<boolean>;
  close(scope: WorkerScope, workerId: string): Promise<boolean>;
  list(scope: WorkerScope): readonly WorkerInfo[];
}

export interface WorkerDelegationPromptOptions {
  readonly browserAvailable: boolean;
  readonly t3Available: boolean;
  /** The linked user's sandboxed shell belongs to workers in this conversation. */
  readonly shellAvailable: boolean;
  readonly watchAvailable: boolean;
}

/**
 * Renders system prompt guidance telling a conversation agent when to delegate
 * work to workers (`worker_start`) and which capabilities belong only
 * to workers in the current session.
 */
export function renderWorkerDelegationSection(options: WorkerDelegationPromptOptions): string {
  const workerOnlyCapabilities: string[] = [];
  if (options.browserAvailable) {
    workerOnlyCapabilities.push(
      "- Real headless browser use (`agent-browser`): open JavaScript-rendered pages, click, fill forms, wait for dynamic content, and take screenshots.",
    );
  }
  if (options.t3Available) {
    workerOnlyCapabilities.push(
      "- T3 Code threads (`t3_thread_*`): hand repository edits, coding, tests, and PR creation to a T3 Code agent.",
    );
  }
  if (options.shellAvailable) {
    workerOnlyCapabilities.push(
      "- A sandboxed shell (`bash`): run commands in the linked user's private workspace, with other users' files and Klein's configuration hidden.",
    );
  }

  const unavailableCapabilities = [
    ...(options.browserAvailable ? [] : ["real browser use via `agent-browser`"]),
    ...(options.t3Available ? [] : ["T3 Code threads via `t3_thread_*`"]),
    ...(options.shellAvailable ? [] : ["a sandboxed shell"]),
  ];

  const lines = [
    "## Workers (`worker_start`)",
    "",
    "Workers run in their own persistent Pi session outside this conversation. Prefer `worker_start` by default for anything beyond a single quick lookup so this conversation stays responsive and free of search/page/tool clutter.",
    "",
    "Delegate to `worker_start` (or `worker_send` to continue an existing worker; check `worker_list` when unsure) for:",
    "- Multi-step web research, reading long pages or multiple sources, comparisons, or verifying primary documentation.",
    "- `codemode` pipelines, MCP tool exploration, or tasks needing several tool calls.",
    ...(options.watchAvailable
      ? [
          "- Recurring watches (`watch_add`) whose wake requires investigation or judgment before reporting back; a watch registered by a worker wakes that worker first and delivers a concise `worker.result`.",
        ]
      : []),
    "- Follow-up investigations on an ongoing thread of work.",
    "",
    "Keep only trivial single-step checks (such as one quick `web_search`, `fetch_content`, or `discord_read`) inline.",
    "",
    ...(workerOnlyCapabilities.length > 0
      ? [
          "Workers in this conversation also have capabilities you do NOT have directly:",
          ...workerOnlyCapabilities,
          "Whenever a request needs these capabilities, delegate with `worker_start` instead of declining or falling back to static `fetch_content`.",
        ]
      : []),
    ...(unavailableCapabilities.length > 0
      ? [
          `This conversation does not have ${unavailableCapabilities.join(" or ")}. Do not start a worker for them or promise to use them.`,
        ]
      : []),
    "",
    "Give `worker_start` a self-contained prompt with the goal, context, URLs, message IDs, and constraints (a worker does not see this conversation history unless you summarize it or pass message IDs for `discord_read`). A worker cannot send Discord messages; its output arrives later as a `worker.result` event, and you decide whether and how to reply.",
  ];

  return lines.join("\n");
}

/**
 * Renders guidance for a worker that has the T3 Code thread tools. Repository
 * work stays in a thread instead of the worker's own session.
 */
export function renderWorkerT3ThreadSection(): string {
  return [
    "## T3 Code threads (`t3_thread_*`)",
    "",
    "Repository work belongs in a T3 Code thread: hand code edits, tests, builds, commits, and PR creation to `t3_thread_start` instead of doing them in your own session.",
    "",
    "Continue the same thread with `t3_thread_send` for follow-ups, and check a long run with `t3_thread_show`. Report the thread's status, result, and link in your result.",
  ].join("\n");
}
