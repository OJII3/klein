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
  /** Optional pre-generated worker id. The coordinator creates one when omitted. */
  readonly id?: string;
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
  /** The conversation can list T3 projects with `t3_project_list`. */
  readonly t3ProjectAvailable: boolean;
  /** The linked user's sandboxed shell belongs to workers in this conversation. */
  readonly shellAvailable: boolean;
  /** Workers can ask the linked user for credentials by direct message. */
  readonly credentialsAvailable: boolean;
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
      "- T3 Code threads (`t3_thread_start`, `t3_thread_send`): hand repository edits, coding, tests, and PR creation to a T3 Code agent, in any repository on this machine, including Klein's own code, dotfiles, and machine settings.",
    );
  }
  if (options.shellAvailable) {
    workerOnlyCapabilities.push(
      "- A sandboxed shell (`bash`): run commands in the linked user's private workspace, with other users' files and Klein's configuration hidden.",
    );
  }
  if (options.credentialsAvailable) {
    workerOnlyCapabilities.push(
      "- Credential handling (`auth_request`, `auth_list`, `auth_run`): ask the linked user for a password or token by private direct message, then run commands with it without exposing the value in the conversation.",
    );
  }

  const unavailableCapabilities = [
    ...(options.browserAvailable ? [] : ["real browser use via `agent-browser`"]),
    ...(options.t3Available
      ? []
      : ["T3 Code thread creation and follow-ups via `t3_thread_start`"]),
    ...(options.shellAvailable ? [] : ["a sandboxed shell"]),
    ...(options.credentialsAvailable ? [] : ["asking the linked user for credentials"]),
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
    ...(options.t3ProjectAvailable
      ? [
          "You can list T3 Code projects directly with `t3_project_list` to choose the project id or workspace path for a worker.",
          "",
        ]
      : []),
    ...(workerOnlyCapabilities.length > 0
      ? [
          "Workers in this conversation also have capabilities you do NOT have directly:",
          ...workerOnlyCapabilities,
          "Whenever a request needs these capabilities, delegate with `worker_start` instead of declining or falling back to static `fetch_content`.",
          ...(options.t3Available
            ? [
                "An owner worker can act on this machine through T3 Code, not just look things up: it can change any repository, dotfiles, or machine settings. Delegate such requests instead of treating them as out of scope.",
              ]
            : []),
        ]
      : []),
    ...(options.credentialsAvailable
      ? [
          "Never ask the user to paste a password, token, or other secret in this conversation. Delegate credential collection to a worker, which asks the linked user by direct message.",
        ]
      : []),
    ...(unavailableCapabilities.length > 0
      ? [
          `This conversation does not have ${unavailableCapabilities.join(" or ")}. Do not start a worker for them or promise to use them.`,
        ]
      : []),
    "",
    "Give `worker_start` a self-contained prompt with the goal, context, URLs, message IDs, and constraints (a worker does not see this conversation history unless you summarize it or pass message IDs for `discord_read`). A worker cannot send Discord messages; its output arrives later as a `worker.result` event, and you decide whether and how to reply.",
    "",
    "A worker is part of how you work, not a separate person you order around. When you reply, speak as the one who did the work: never say you had, let, or made a worker do something (「ワーカーにやらせる」「ワーカーに調べさせる」), and do not mention the worker to the user.",
  ];

  return lines.join("\n");
}

/**
 * Renders guidance for a worker that has the T3 Code thread tools. Repository
 * work stays in a thread instead of the worker's own session, and a thread can
 * reach any repository or machine setting rather than only Klein's checkout.
 */
export function renderWorkerT3ThreadSection(): string {
  return [
    "## T3 Code threads (`t3_thread_*`)",
    "",
    "Repository work belongs in a T3 Code thread: hand code edits, tests, builds, commits, and PR creation to `t3_thread_start` instead of doing them in your own session.",
    "",
    "Threads are not limited to Klein's own repository. Pass a project id or a path inside any existing repository in `project` to work on that repository, including Klein's source code. Use `t3_project_list` when you need to find the right project. A thread runs directly on this machine, so it can also edit dotfiles and change machine settings.",
    "",
    "Continue the same thread with `t3_thread_send` for follow-ups, and check a long run with `t3_thread_show`. Report the thread's status, result, and link in your result.",
  ].join("\n");
}

/**
 * Guidance for a worker that can request credentials from the linked user.
 * Values stay outside the model; `auth_run` injects them into the sandbox.
 */
export function renderWorkerAuthSection(): string {
  return [
    "## Credentials (`auth_*`)",
    "",
    "When a task needs a password, token, or other secret, use `auth_list` to check what is already saved and `auth_request` to ask the linked user by direct message. The user answers in a private modal; the values are encrypted and never enter this conversation or your result. If these tools are not active, load them with `tool_search`.",
    "",
    "Use `auth_run` (when available) to run a command with a saved credential. It injects each field as `KLEIN_AUTH_<SERVICE>_<FIELD>` and redacts those values from the output. Do not echo a credential, do not put one in a file that stays in the workspace, and do not ask the user to paste a secret into the channel.",
    "",
    "If a CLI expects a fixed environment variable, set `env` on the field when requesting it (for example `GH_TOKEN` for `gh`); `auth_run` injects both names. For a tool that reads a config file, write the value to a file under `/tmp` inside the command and remove it when the command ends; do not leave it in the linked user's home.",
    "",
    "Use `auth_delete` only when the user explicitly asks to remove or revoke a saved credential.",
    "",
    "`auth_request` returns immediately. When the user submits or cancels, you receive a new message; continue the task then instead of waiting in the same turn.",
  ].join("\n");
}
