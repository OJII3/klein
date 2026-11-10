import type { WatchTask } from "../domain/scheduled-task";

export interface WatchCheckResult {
  readonly output: string;
  readonly exitCode: number;
  readonly durationMs: number;
  /** State after applying the script's `store()` writes. */
  readonly state: Readonly<Record<string, unknown>>;
}

export interface WatchCheckRunner {
  run(watch: WatchTask): Promise<WatchCheckResult>;
}

export class WatchCheckError extends Error {
  constructor(
    message: string,
    readonly exitCode?: number,
    readonly stderr?: string,
  ) {
    super(message);
    this.name = "WatchCheckError";
  }
}
