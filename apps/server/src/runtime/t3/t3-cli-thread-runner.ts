import { spawn } from "node:child_process";

import type {
  T3ThreadMessage,
  T3ThreadPullRequest,
  T3ThreadRun,
  T3ThreadRunner,
  T3ThreadSummary,
} from "@agents/tools/t3-thread";
import { isRecord } from "@shared/type-guards";

const DEFAULT_MAX_OUTPUT_CHARS = 1_000_000;
const MAX_ERROR_CHARS = 2_000;

export interface T3CliThreadRunnerOptions {
  readonly command?: string;
  readonly cwd?: string;
  readonly maxOutputChars?: number;
}

/**
 * T3 Code の CLI を子プロセスとして呼ぶ。`t3` はシェルを介さずに起動し、
 * 引数は配列のまま渡す。
 */
export function createT3CliThreadRunner(options: T3CliThreadRunnerOptions = {}): T3ThreadRunner {
  const command = options.command ?? "t3";
  const cwd = options.cwd ?? process.cwd();
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

  const run = (args: readonly string[], signal?: AbortSignal) =>
    runCommand(command, args, { cwd, maxOutputChars, ...(signal ? { signal } : {}) });

  return {
    async list(project, signal) {
      const args = ["thread", "list", "--json"];
      if (project) args.push("--project", project);
      const output = await run(args, signal);
      const value = parseOutput(output, "t3 thread list");
      if (!Array.isArray(value)) {
        throw new TypeError("t3 thread list returned an unexpected result");
      }
      return value.map((thread) => toThreadSummary(thread));
    },
    async start(input, signal) {
      const args = ["thread", "start", "--json"];
      if (input.wait) args.push("--wait");
      if (input.title) args.push("--title", input.title);
      if (input.worktree) args.push("--worktree", input.worktree);
      if (input.branch) args.push("--branch", input.branch);
      args.push(input.project ?? cwd, input.message);
      return toThreadRun(await run(args, signal), "t3 thread start", "running");
    },
    async send(input, signal) {
      const args = ["thread", "send", "--json"];
      if (input.wait) args.push("--wait");
      args.push(input.threadId, input.message);
      return toThreadRun(await run(args, signal), "t3 thread send", "running");
    },
    async show(threadId, messages, signal) {
      const args = ["thread", "show", "--json", "--messages", String(messages), threadId];
      const value = parseOutput(await run(args, signal), "t3 thread show");
      if (!isRecord(value) || !isRecord(value.thread)) {
        throw new Error("t3 thread show returned an unexpected result");
      }
      const parsedMessages = Array.isArray(value.messages)
        ? value.messages.flatMap((message) => {
            const parsed = toThreadMessage(message);
            return parsed ? [parsed] : [];
          })
        : [];
      return { thread: toThreadSummary(value.thread), messages: parsedMessages };
    },
  };
}

interface RunOptions {
  readonly cwd: string;
  readonly maxOutputChars: number;
  readonly signal?: AbortSignal;
}

interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

function runCommand(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("The T3 Code command was aborted"));
      return;
    }

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      callback();
    };
    const append = (current: string, chunk: string): string => {
      if (current.length >= options.maxOutputChars) return current;
      return (current + chunk).slice(0, options.maxOutputChars);
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(() => reject(new Error("The T3 Code command was aborted")));
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      finish(() => reject(new Error(`Failed to run ${command}: ${error.message}`)));
    });
    child.on("close", (code) => {
      finish(() => resolve({ stdout, stderr, code }));
    });
    options.signal?.addEventListener("abort", abort, { once: true });
  });
}

function parseOutput(output: CommandOutput, label: string): unknown {
  const text = output.stdout.trim();
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      // Fall through to the exit-code handling below.
    }
  }

  const detail = (output.stderr.trim() || text).slice(0, MAX_ERROR_CHARS);
  const suffix = detail ? `: ${detail}` : "";
  const reason =
    output.code === 0 ? "returned unexpected output" : `failed (exit ${output.code ?? "unknown"})`;
  throw new Error(`${label} ${reason}${suffix}`);
}

function toThreadSummary(value: unknown): T3ThreadSummary {
  if (!isRecord(value) || typeof value.threadId !== "string") {
    throw new Error("T3 Code returned a thread without an id");
  }
  const linkedPullRequest = toPullRequest(value.linkedPullRequest);
  return {
    id: value.threadId,
    title: typeof value.title === "string" ? value.title : "",
    status: typeof value.status === "string" ? value.status : "unknown",
    ...(typeof value.link === "string" ? { link: value.link } : {}),
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
    ...(typeof value.branch === "string" ? { branch: value.branch } : {}),
    ...(typeof value.worktreePath === "string" ? { worktreePath: value.worktreePath } : {}),
    ...(typeof value.pendingRequestCount === "number"
      ? { pendingRequestCount: value.pendingRequestCount }
      : {}),
    ...(typeof value.pullRequestCount === "number"
      ? { pullRequestCount: value.pullRequestCount }
      : {}),
    ...(typeof value.openPullRequestCount === "number"
      ? { openPullRequestCount: value.openPullRequestCount }
      : {}),
    ...(linkedPullRequest ? { linkedPullRequest } : {}),
  };
}

function toPullRequest(value: unknown): T3ThreadPullRequest | undefined {
  if (
    !isRecord(value) ||
    typeof value.repository !== "string" ||
    typeof value.number !== "number" ||
    typeof value.url !== "string"
  ) {
    return undefined;
  }
  return { repository: value.repository, number: value.number, url: value.url };
}

function toThreadRun(output: CommandOutput, label: string, fallbackStatus: string): T3ThreadRun {
  const value = parseOutput(output, label);
  if (!isRecord(value) || typeof value.threadId !== "string") {
    throw new Error(`${label} returned an unexpected result`);
  }
  return {
    threadId: value.threadId,
    status: typeof value.status === "string" ? value.status : fallbackStatus,
    ...(typeof value.link === "string" && value.link.trim() ? { link: value.link } : {}),
    ...(typeof value.reply === "string" && value.reply.trim() ? { reply: value.reply } : {}),
    ...(typeof value.error === "string" && value.error.trim() ? { error: value.error } : {}),
  };
}

function toThreadMessage(value: unknown): T3ThreadMessage | undefined {
  if (!isRecord(value) || typeof value.role !== "string" || typeof value.text !== "string") {
    return undefined;
  }
  return { role: value.role, text: value.text };
}
