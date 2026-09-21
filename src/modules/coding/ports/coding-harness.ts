import type { CodingProject, CodingProjectId, CodingProjectState } from "../domain/coding-project";
import type { CodingRun, CodingRunId, CodingSessionId } from "../domain/coding-run";

export interface StartCodingRunInput {
  readonly projectId: CodingProjectId;
  readonly prompt: string;
  readonly sessionId?: CodingSessionId;
}

/**
 * Coding operations keyed by opaque harness-native project IDs. Implementations resolve
 * local roots and harness-native session handles internally.
 */
export interface CodingHarness {
  listProjects(): Promise<readonly CodingProject[]>;
  getProjectState(projectId: CodingProjectId): Promise<CodingProjectState>;
  startRun(input: StartCodingRunInput): Promise<CodingRun>;
  getRun(runId: CodingRunId): Promise<CodingRun>;
  cancelRun(runId: CodingRunId): Promise<void>;
}
