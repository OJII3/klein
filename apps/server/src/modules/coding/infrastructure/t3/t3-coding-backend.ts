import type {
  CodingTaskDetail,
  CodingTaskRun,
  CodingTaskSendInput,
  CodingTaskStartInput,
  CodingTaskStatus,
  CodingTaskSummary,
  CodingTaskWaitInput,
  CodingTaskWaitResult,
} from "../../domain/coding-task";
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

const STATUSES: Readonly<Record<string, CodingTaskStatus>> = {
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
      return (await runner.list(project, signal)).map((thread) => toTaskSummary(thread));
    },
    async start(input: CodingTaskStartInput, signal) {
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
      return toTaskRun(result);
    },
    async send(input: CodingTaskSendInput, signal) {
      const result = await runner.send(
        { threadId: input.taskId, message: input.message, wait: input.wait },
        signal,
      );
      return toTaskRun(result);
    },
    async wait(input: CodingTaskWaitInput, signal): Promise<CodingTaskWaitResult> {
      const result = await runner.wait(
        { threadId: input.taskId, messages: input.messages, timeoutMs: input.timeoutMs },
        signal,
      );
      return {
        task: toTaskSummary(result.thread),
        messages: result.messages,
        timedOut: result.timedOut,
      };
    },
    async show(taskId, messages, signal): Promise<CodingTaskDetail> {
      const result = await runner.show(taskId, messages, signal);
      return {
        task: toTaskSummary(result.thread),
        messages: result.messages,
      };
    },
  };
}

function toTaskStatus(status: string): CodingTaskStatus {
  return STATUSES[status] ?? "unknown";
}

function toTaskSummary(thread: T3ThreadSummary): CodingTaskSummary {
  const linkedPullRequest = thread.linkedPullRequest;
  return {
    id: thread.id,
    title: thread.title,
    status: toTaskStatus(thread.status),
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

function toTaskRun(result: {
  readonly threadId: string;
  readonly status: string;
  readonly link?: string;
  readonly reply?: string;
  readonly error?: string;
}): CodingTaskRun {
  return {
    taskId: result.threadId,
    status: toTaskStatus(result.status),
    ...(result.link ? { link: result.link } : {}),
    ...(result.reply ? { reply: result.reply } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}
