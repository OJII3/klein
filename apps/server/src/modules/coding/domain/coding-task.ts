export type CodingTaskStatus =
  "running" | "waiting" | "idle" | "completed" | "failed" | "cancelled" | "unknown";

export interface CodingTaskPullRequest {
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

export interface CodingTaskSummary {
  readonly id: string;
  readonly title: string;
  readonly status: CodingTaskStatus;
  readonly link?: string;
  readonly updatedAt?: string;
  readonly branch?: string;
  readonly worktreePath?: string;
  readonly pendingQuestionCount?: number;
  readonly pullRequestCount?: number;
  readonly openPullRequestCount?: number;
  readonly pullRequest?: CodingTaskPullRequest;
}

export interface CodingTaskMessage {
  readonly role: string;
  readonly text: string;
}

export interface CodingTaskDetail {
  readonly task: CodingTaskSummary;
  readonly messages: readonly CodingTaskMessage[];
}

export interface CodingTaskRun {
  readonly taskId: string;
  readonly status: CodingTaskStatus;
  readonly link?: string;
  readonly reply?: string;
  readonly error?: string;
}

export interface CodingTaskStartInput {
  readonly project?: string;
  readonly message: string;
  readonly title?: string;
  readonly wait: boolean;
  readonly worktree?: string;
  readonly branch?: string;
}

export interface CodingTaskSendInput {
  readonly taskId: string;
  readonly message: string;
  readonly wait: boolean;
}

export interface CodingTaskWaitInput {
  readonly taskId: string;
  readonly messages: number;
  readonly timeoutMs: number;
}

export interface CodingTaskWaitResult extends CodingTaskDetail {
  readonly timedOut: boolean;
}

export interface CodingProject {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

const SETTLED_STATUSES = new Set<CodingTaskStatus>([
  "waiting",
  "idle",
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);

export function isCodingTaskSettled(task: CodingTaskSummary): boolean {
  return SETTLED_STATUSES.has(task.status) || (task.pendingQuestionCount ?? 0) > 0;
}

export function isCodingTaskWaiting(task: CodingTaskSummary): boolean {
  return task.status === "waiting" || (task.pendingQuestionCount ?? 0) > 0;
}

export function formatCodingTaskRef(backendId: string, taskId: string): string {
  return `${backendId}:${taskId}`;
}

export interface ParsedCodingTaskRef {
  readonly backendId: string;
  readonly taskId: string;
}

export function parseCodingTaskRef(value: string): ParsedCodingTaskRef | undefined {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return {
    backendId: value.slice(0, separator),
    taskId: value.slice(separator + 1),
  };
}
