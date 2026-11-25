export type CodingSessionStatus =
  "running" | "waiting" | "idle" | "completed" | "failed" | "cancelled" | "unknown";

export interface CodingSessionPullRequest {
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

export interface CodingSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly status: CodingSessionStatus;
  readonly link?: string;
  readonly updatedAt?: string;
  readonly branch?: string;
  readonly worktreePath?: string;
  readonly pendingQuestionCount?: number;
  readonly pullRequestCount?: number;
  readonly openPullRequestCount?: number;
  readonly pullRequest?: CodingSessionPullRequest;
}

export interface CodingSessionMessage {
  readonly role: string;
  readonly text: string;
}

export interface CodingSessionDetail {
  readonly session: CodingSessionSummary;
  readonly messages: readonly CodingSessionMessage[];
}

export interface CodingSessionRun {
  readonly sessionId: string;
  readonly status: CodingSessionStatus;
  readonly link?: string;
  readonly reply?: string;
  readonly error?: string;
}

export interface CodingSessionStartInput {
  readonly project?: string;
  readonly message: string;
  readonly title?: string;
  readonly wait: boolean;
  readonly worktree?: string;
  readonly branch?: string;
}

export interface CodingSessionSendInput {
  readonly sessionId: string;
  readonly message: string;
  readonly wait: boolean;
}

export interface CodingSessionWaitInput {
  readonly sessionId: string;
  readonly messages: number;
  readonly timeoutMs: number;
}

export interface CodingSessionWaitResult extends CodingSessionDetail {
  readonly timedOut: boolean;
}

export interface CodingProject {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

const SETTLED_STATUSES = new Set<CodingSessionStatus>([
  "waiting",
  "idle",
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);

export function isCodingSessionSettled(session: CodingSessionSummary): boolean {
  return SETTLED_STATUSES.has(session.status) || (session.pendingQuestionCount ?? 0) > 0;
}

export function isCodingSessionWaiting(session: CodingSessionSummary): boolean {
  return session.status === "waiting" || (session.pendingQuestionCount ?? 0) > 0;
}

export function formatCodingSessionRef(backendId: string, sessionId: string): string {
  return `${backendId}:${sessionId}`;
}

export interface ParsedCodingSessionRef {
  readonly backendId: string;
  readonly sessionId: string;
}

export function parseCodingSessionRef(value: string): ParsedCodingSessionRef | undefined {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return {
    backendId: value.slice(0, separator),
    sessionId: value.slice(separator + 1),
  };
}
