import type {
  CodingSessionDetail,
  CodingSessionRun,
  CodingSessionSendInput,
  CodingSessionStartInput,
  CodingSessionSummary,
  CodingSessionWaitInput,
  CodingSessionWaitResult,
} from "../domain/coding-session";

export interface CodingBackendCapabilities {
  readonly worktree: boolean;
}

export interface CodingBackend {
  readonly id: string;
  readonly label: string;
  readonly capabilities: CodingBackendCapabilities;
  list(project: string | undefined, signal?: AbortSignal): Promise<readonly CodingSessionSummary[]>;
  start(input: CodingSessionStartInput, signal?: AbortSignal): Promise<CodingSessionRun>;
  send(input: CodingSessionSendInput, signal?: AbortSignal): Promise<CodingSessionRun>;
  wait(input: CodingSessionWaitInput, signal?: AbortSignal): Promise<CodingSessionWaitResult>;
  show(sessionId: string, messages: number, signal?: AbortSignal): Promise<CodingSessionDetail>;
}
