import type { CodingRun } from "./coding-run";

/** Canonical repository identity in host/owner/repository form, such as github.com/owner/repo. */
export type CodingProjectId = `${string}/${string}/${string}`;

export interface CodingProject {
  readonly id: CodingProjectId;
}

export interface CodingProjectState {
  readonly project: CodingProject;
  readonly activeRuns: readonly CodingRun[];
}
