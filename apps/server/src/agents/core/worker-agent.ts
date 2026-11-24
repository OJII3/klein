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
  readonly id?: string;
  readonly ownerFeaturesAllowed: boolean;
  readonly prompt: string;
  readonly closeAfterResult?: boolean;
  /** Conversation session whose history the worker should inherit. */
  readonly contextSessionFile?: string;
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
  readonly t3ProjectAvailable: boolean;
  readonly shellAvailable: boolean;
  readonly secretsAvailable: boolean;
  readonly watchAvailable: boolean;
}

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
      "- A sandboxed shell (`bash`): run commands in the linked user's private workspace, with other users' files and Klein's configuration hidden. Missing CLI tools can be installed into the sandbox's `~/.local/bin`, which stays on `PATH`.",
    );
  }
  if (options.secretsAvailable) {
    workerOnlyCapabilities.push(
      "- Secret handling (`secret_request`, `secret_list`, `secret_run`, `secret_delete`): ask the linked user for a password or token by private direct message, then run commands with it without exposing the value in the conversation.",
    );
  }

  const unavailableCapabilities = [
    ...(options.browserAvailable ? [] : ["real browser use via `agent-browser`"]),
    ...(options.t3Available
      ? []
      : ["T3 Code thread creation and follow-ups via `t3_thread_start`"]),
    ...(options.shellAvailable ? [] : ["a sandboxed shell"]),
    ...(options.secretsAvailable ? [] : ["asking the linked user for secrets"]),
  ];

  const lines = [
    "## Workers (`worker_start`)",
    "",
    "Workers run in their own persistent Pi session outside this conversation. Each worker starts with a copy of this conversation's history up to the moment you start it, so it already knows the recent context. Prefer `worker_start` by default for anything beyond a single quick lookup so this conversation stays responsive and free of search/page/tool clutter.",
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
    ...(options.secretsAvailable
      ? [
          "Never ask the user to paste a password, token, or other secret in this conversation. Delegate secret collection to a worker, which asks the linked user by direct message.",
        ]
      : []),
    ...(unavailableCapabilities.length > 0
      ? [
          `This conversation does not have ${unavailableCapabilities.join(" or ")}. Do not start a worker for them or promise to use them.`,
        ]
      : []),
    "",
    "Give `worker_start` only the specific goal or next step. The worker inherits this conversation's history, so do not repeat background, URLs, message IDs, or constraints that are already here. It does not see messages that arrive after you start it. A worker cannot send Discord messages; its output arrives later as a `worker.result` event, and you decide whether and how to reply.",
    "",
    "A worker is part of how you work, not a separate person you order around. When you reply, speak as the one who did the work: never say you had, let, or made a worker do something (「ワーカーにやらせる」「ワーカーに調べさせる」), and do not mention the worker to the user.",
  ];

  return lines.join("\n");
}

export function renderWorkerT3ThreadSection(): string {
  return [
    "## T3 Code threads (`t3_thread_*`)",
    "",
    "Repository work belongs in a T3 Code thread: hand code edits, tests, builds, commits, and PR creation to `t3_thread_start` instead of doing them in your own session.",
    "",
    "Threads are not limited to Klein's own repository. Pass a project id or a path inside any existing repository in `project` to work on that repository, including Klein's source code. Use `t3_project_list` when you need to find the right project. A thread runs directly on this machine, so it can also edit dotfiles and change machine settings.",
    "",
    "Continue the same thread with `t3_thread_send` for follow-ups, and check a long run with `t3_thread_show`. To wait for an existing thread to finish, call `t3_thread_wait`; it returns when the latest run ends, asks for an answer, or the timeout expires. Report the thread's status and result, and include the thread link and any pull request from `t3_thread_show` in your result.",
    "",
    "A thread reported as `waiting` is asking a question. Read it with `t3_thread_show`, answer it with `t3_thread_send`, or report the question instead of waiting for the run to finish. If `t3_thread_wait` times out, the run is still going: call it again or report the current state.",
  ].join("\n");
}

export function renderWorkerSecretsSection(): string {
  return [
    "## Secrets (`secret_*`)",
    "",
    "When a task needs a password, token, or other secret, use `secret_list` to check what is already saved and `secret_request` to ask the linked user by direct message. The user answers in a private modal; the values are encrypted and never enter this conversation or your result. If these tools are not active, load them with `tool_search`.",
    "",
    "Use `secret_run` (when available) to run a command with a saved secret. It injects each field as `KLEIN_SECRET_<SERVICE>_<FIELD>` and redacts those values from the output. Do not echo a secret, do not put one in a file that stays in the workspace, and do not ask the user to paste a secret into the channel.",
    "",
    "If a CLI expects a fixed environment variable, set `env` on the field when requesting it (for example `SERVICE_TOKEN`); `secret_run` injects both names. For a tool that reads a config file, write the value to a file under `/tmp` inside the command and remove it when the command ends; do not leave it in the linked user's home.",
    "",
    "Device-code logins that only ask the user for a one-time code are fine. The risk is the long-lived state the CLI writes after login: if it is stored in the sandbox, you can read it. Use the CLI's own login/logout only when the user accepts that, and prefer a hidden browser profile or a host-side adapter when the token must stay unreadable.",
    "",
    "Use `secret_delete` only when the user explicitly asks to remove or revoke a saved secret.",
    "",
    "`secret_request` returns immediately. When the user submits or cancels, you receive a new message; continue the task then instead of waiting in the same turn.",
  ].join("\n");
}
