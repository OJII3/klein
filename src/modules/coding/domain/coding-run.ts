import type { CodingProjectId } from "./coding-project";

/** Opaque handle managed by the selected harness adapter. */
export type CodingRunId = string;

/** Opaque, adapter-managed handle for continuing a harness session. */
export type CodingSessionId = string;

export type CodingRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface CodingRun {
  readonly id: CodingRunId;
  readonly projectId: CodingProjectId;
  readonly sessionId?: CodingSessionId;
  readonly status: CodingRunStatus;
  readonly startedAt?: Date;
  readonly updatedAt: Date;
  readonly result?: string;
  readonly error?: string;
}
