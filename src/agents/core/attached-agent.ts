export type AttachedTaskStatus = "running" | "idle" | "failed";

export interface AttachedTaskInfo {
  readonly id: string;
  readonly prompt: string;
  readonly status: AttachedTaskStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AttachedTaskResult {
  readonly taskId: string;
  readonly status: "completed" | "failed";
  /** The worker's assistant text, or a placeholder when it produced none. */
  readonly text: string;
  readonly error?: string;
}

export interface AttachedTaskStartInput {
  readonly channelId: string;
  /** The access scope of the conversation that started the task. */
  readonly accessScope: string;
  readonly prompt: string;
}

/**
 * The conversation-side controls for attached tasks. The conversation agent
 * starts a task, sends follow-ups, closes it, and lists its own tasks. The
 * attached agent never writes to the conversation surface; results return
 * through the coordinator's result callback.
 */
export interface AttachedTaskControl {
  start(input: AttachedTaskStartInput): Promise<string>;
  send(taskId: string, message: string): Promise<boolean>;
  close(taskId: string): Promise<boolean>;
  list(channelId: string): readonly AttachedTaskInfo[];
}
