import type { AccessScope } from "@shared/access";
import type { ConversationKey } from "@shared/conversation-key";

/**
 * `interrupted` marks a task whose prompt was still running when the process
 * stopped. The task is restored, but its prompt is not re-run automatically.
 */
export type AttachedTaskStatus = "running" | "idle" | "failed" | "interrupted";

export interface AttachedTaskInfo {
  readonly id: string;
  readonly prompt: string;
  readonly status: AttachedTaskStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AttachedTaskResult {
  readonly taskId: string;
  readonly status: "completed" | "failed";
  /** The worker's assistant text, or a placeholder when it produced none. */
  readonly text: string;
  readonly error?: string;
}

export interface AttachedTaskScope {
  readonly conversationKey: ConversationKey;
  readonly accessScope: AccessScope;
}

export interface AttachedTaskStartInput extends AttachedTaskScope {
  readonly ownerFeaturesAllowed: boolean;
  readonly prompt: string;
  /**
   * Closes the task after its result is delivered. Use this for a task that
   * exists only to produce one result, such as a reminder.
   */
  readonly closeAfterResult?: boolean;
}
export interface AttachedTaskControl {
  start(input: AttachedTaskStartInput): Promise<string>;
  send(scope: AttachedTaskScope, taskId: string, message: string): Promise<boolean>;
  close(scope: AttachedTaskScope, taskId: string): Promise<boolean>;
  list(scope: AttachedTaskScope): readonly AttachedTaskInfo[];
}

export interface WorkerDelegationPromptOptions {
  readonly ownerBrowserAvailable: boolean;
  readonly ownerT3Available: boolean;
  readonly watchAvailable: boolean;
}

/**
 * Renders system prompt guidance telling a conversation agent when to delegate
 * work to attached workers (`worker_start`) and which capabilities belong only
 * to workers in the current session.
 */
export function renderWorkerDelegationSection(options: WorkerDelegationPromptOptions): string {
  const workerOnlyCapabilities: string[] = [];
  if (options.ownerBrowserAvailable) {
    workerOnlyCapabilities.push(
      "- Real headless browser automation (`agent-browser` via `tool_search`): open JavaScript-rendered pages, click, fill forms, wait for dynamic content, and take screenshots (see the `browser-automation` skill).",
    );
  }
  if (options.ownerT3Available) {
    workerOnlyCapabilities.push(
      "- T3 Code threads (`t3_thread_*`): hand repository edits, coding, tests, and PR creation to a T3 Code agent (see the `t3-thread` skill).",
    );
  }

  const lines = [
    "## Workers (`worker_start` / 付随タスク)",
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
          "This conversation has owner permissions, so workers also have capabilities you do NOT have directly:",
          ...workerOnlyCapabilities,
          "Whenever a request needs these capabilities, delegate with `worker_start` instead of declining or falling back to static `fetch_content`.",
        ]
      : [
          "Owner-only worker capabilities (real browser automation via `agent-browser` and T3 Code threads via `t3_thread_*`) are NOT available in this conversation. Do not start a worker for them or promise to use them.",
        ]),
    "",
    "Give `worker_start` a self-contained prompt with the goal, context, URLs, message IDs, and constraints (a worker does not see this conversation history unless you summarize it or pass message IDs for `discord_read`). A worker cannot send Discord messages; its output arrives later as a `worker.result` event, and you decide whether and how to reply.",
  ];

  return lines.join("\n");
}
