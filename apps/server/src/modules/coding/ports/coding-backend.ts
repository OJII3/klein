import type {
  CodingProject,
  CodingTaskDetail,
  CodingTaskRun,
  CodingTaskSendInput,
  CodingTaskStartInput,
  CodingTaskSummary,
  CodingTaskWaitInput,
  CodingTaskWaitResult,
} from "../domain/coding-task";

export interface CodingBackendCapabilities {
  readonly projects: boolean;
  readonly worktree: boolean;
  readonly questions: boolean;
  readonly pullRequest: boolean;
}

export interface CodingBackend {
  readonly id: string;
  readonly label: string;
  readonly capabilities: CodingBackendCapabilities;
  listProjects?(signal?: AbortSignal): Promise<readonly CodingProject[]>;
  list(project: string | undefined, signal?: AbortSignal): Promise<readonly CodingTaskSummary[]>;
  start(input: CodingTaskStartInput, signal?: AbortSignal): Promise<CodingTaskRun>;
  send(input: CodingTaskSendInput, signal?: AbortSignal): Promise<CodingTaskRun>;
  wait(input: CodingTaskWaitInput, signal?: AbortSignal): Promise<CodingTaskWaitResult>;
  show(taskId: string, messages: number, signal?: AbortSignal): Promise<CodingTaskDetail>;
}
