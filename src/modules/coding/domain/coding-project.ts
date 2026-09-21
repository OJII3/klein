import type { CodingRun } from "./coding-run";

/** Opaque project ID supplied by the connected coding harness. */
export type CodingProjectId = string;

export interface CodingProject {
  readonly id: CodingProjectId;
  readonly directory: string;
  readonly name?: string;
}

export interface CodingProjectState {
  readonly project: CodingProject;
  readonly activeRuns: readonly CodingRun[];
}
