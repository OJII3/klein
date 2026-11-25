import type {
  CodingSessionDetail,
  CodingSessionRun,
  CodingSessionSendInput,
  CodingSessionStartInput,
  CodingSessionStatus,
  CodingSessionSummary,
  CodingSessionWaitInput,
  CodingSessionWaitResult,
} from "../../domain/coding-session";
import type { CodingBackend } from "../../ports/coding-backend";
import {
  createT3CliThreadRunner,
  type T3CliThreadRunnerOptions,
  type T3ThreadSummary,
} from "./t3-cli-thread-runner";
import {
  createT3SqliteProjectLister,
  type T3ProjectLister,
  type T3SqliteProjectListerOptions,
} from "./t3-sqlite-project-lister";

export interface T3CodingBackendOptions
  extends T3CliThreadRunnerOptions, T3SqliteProjectListerOptions {
  readonly projectLister?: T3ProjectLister;
}

const STATUSES: Readonly<Record<string, CodingSessionStatus>> = {
  running: "running",
  waiting: "waiting",
  idle: "idle",
  completed: "completed",
  failed: "failed",
  interrupted: "failed",
  rolled_back: "failed",
  cancelled: "cancelled",
};

export function createT3CodingBackend(options: T3CodingBackendOptions = {}): CodingBackend {
  const runner = createT3CliThreadRunner(options);
  const projectLister = options.projectLister ?? createT3SqliteProjectLister(options);

  return {
    id: "t3",
    label: "T3 Code",
    capabilities: {
      projects: true,
      worktree: true,
      questions: true,
      pullRequest: true,
    },
    listProjects: (signal) => projectLister.list(signal),
    async list(project, signal) {
      return (await runner.list(project, signal)).map((thread) => toSessionSummary(thread));
    },
    async start(input: CodingSessionStartInput, signal) {
      const result = await runner.start(
        {
          ...(input.project ? { project: input.project } : {}),
          message: input.message,
          ...(input.title ? { title: input.title } : {}),
          wait: input.wait,
          ...(input.worktree ? { worktree: input.worktree } : {}),
          ...(input.branch ? { branch: input.branch } : {}),
        },
        signal,
      );
      return toSessionRun(result);
    },
    async send(input: CodingSessionSendInput, signal) {
      const result = await runner.send(
        { threadId: input.sessionId, message: input.message, wait: input.wait },
        signal,
      );
      return toSessionRun(result);
    },
    async wait(input: CodingSessionWaitInput, signal): Promise<CodingSessionWaitResult> {
      const result = await runner.wait(
        { threadId: input.sessionId, messages: input.messages, timeoutMs: input.timeoutMs },
        signal,
      );
      return {
        session: toSessionSummary(result.thread),
        messages: result.messages,
        timedOut: result.timedOut,
      };
    },
    async show(sessionId, messages, signal): Promise<CodingSessionDetail> {
      const result = await runner.show(sessionId, messages, signal);
      return {
        session: toSessionSummary(result.thread),
        messages: result.messages,
      };
    },
  };
}

function toSessionStatus(status: string): CodingSessionStatus {
  return STATUSES[status] ?? "unknown";
}

function toSessionSummary(thread: T3ThreadSummary): CodingSessionSummary {
  const linkedPullRequest = thread.linkedPullRequest;
  return {
    id: thread.id,
    title: thread.title,
    status: toSessionStatus(thread.status),
    ...(thread.link ? { link: thread.link } : {}),
    ...(thread.updatedAt ? { updatedAt: thread.updatedAt } : {}),
    ...(thread.branch ? { branch: thread.branch } : {}),
    ...(thread.worktreePath ? { worktreePath: thread.worktreePath } : {}),
    ...(thread.pendingRequestCount !== undefined
      ? { pendingQuestionCount: thread.pendingRequestCount }
      : {}),
    ...(thread.pullRequestCount !== undefined ? { pullRequestCount: thread.pullRequestCount } : {}),
    ...(thread.openPullRequestCount !== undefined
      ? { openPullRequestCount: thread.openPullRequestCount }
      : {}),
    ...(linkedPullRequest ? { pullRequest: linkedPullRequest } : {}),
  };
}

function toSessionRun(result: {
  readonly threadId: string;
  readonly status: string;
  readonly link?: string;
  readonly reply?: string;
  readonly error?: string;
}): CodingSessionRun {
  return {
    sessionId: result.threadId,
    status: toSessionStatus(result.status),
    ...(result.link ? { link: result.link } : {}),
    ...(result.reply ? { reply: result.reply } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}
