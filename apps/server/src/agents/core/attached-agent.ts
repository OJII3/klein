import type { ConversationKey } from "@shared/conversation-key";

/**
 * `interrupted` marks a task whose prompt was still running when the process
 * stopped. The task is restored, but its prompt is not re-run automatically.
 */
export type AttachedTaskStatus = "running" | "idle" | "failed" | "interrupted";

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

export interface AttachedTaskScope {
  readonly conversationKey: ConversationKey;
  /** The access scope of the conversation that owns the task. */
  readonly accessScope: string;
}

export interface AttachedTaskStartInput extends AttachedTaskScope {
  /** Whether the conversation allows owner-only tools for this task. */
  readonly ownerFeaturesAllowed: boolean;
  readonly prompt: string;
  /**
   * Closes the task after its result is delivered. Use this for a task that
   * exists only to produce one result, such as a reminder.
   */
  readonly closeAfterResult?: boolean;
}

/**
 * The conversation-side controls for attached tasks. The conversation agent
 * starts a task, sends follow-ups, closes it, and lists its own tasks. The
 * attached agent never writes to the conversation surface; results return
 * through the coordinator's result callback.
 */
export interface AttachedTaskControl {
  start(input: AttachedTaskStartInput): Promise<string>;
  send(scope: AttachedTaskScope, taskId: string, message: string): Promise<boolean>;
  close(scope: AttachedTaskScope, taskId: string): Promise<boolean>;
  list(scope: AttachedTaskScope): readonly AttachedTaskInfo[];
}
