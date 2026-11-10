import type { Logger } from "pino";

import type { TaskCoordinator } from "@app/task-coordinator";
import {
  formatDiscordMessage,
  type DiscordMessage,
  type DiscordUser,
} from "@modules/discord/domain/discord-message";
import type {
  UserMemoryIdentity,
  UserMemoryMessage,
  UserMemoryProcessor,
  UserMemoryStore,
} from "../domain/user-memory";

const DEFAULT_IDLE_SECONDS = 180;
const DEFAULT_MAX_BATCH_AGE_SECONDS = 1_800;
const DEFAULT_MAX_BATCH_MESSAGES = 32;

interface UserMemoryQueue {
  readonly messages: DiscordMessage[];
  processing: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  maxAgeTimer?: ReturnType<typeof setTimeout>;
}

export interface UserMemoryCoordinatorOptions {
  readonly store: UserMemoryStore;
  readonly processor: UserMemoryProcessor;
  readonly logger: Logger;
  readonly taskCoordinator: TaskCoordinator;
  readonly idleSeconds?: number;
  readonly maxBatchAgeSeconds?: number;
  readonly maxBatchMessages?: number;
}

/**
 * Creates a user memory as soon as Klein handles a message from that user, then lets a
 * background model fold the batch into the memory after the conversation goes idle.
 */
export class UserMemoryCoordinator {
  private readonly logger: Logger;
  private readonly idleSeconds: number;
  private readonly maxBatchAgeSeconds: number;
  private readonly maxBatchMessages: number;
  private readonly queues = new Map<string, UserMemoryQueue>();
  private disposed = false;

  constructor(private readonly options: UserMemoryCoordinatorOptions) {
    this.logger = options.logger.child({ component: "user-memory-coordinator" });
    this.idleSeconds = options.idleSeconds ?? DEFAULT_IDLE_SECONDS;
    this.maxBatchAgeSeconds = options.maxBatchAgeSeconds ?? DEFAULT_MAX_BATCH_AGE_SECONDS;
    this.maxBatchMessages = options.maxBatchMessages ?? DEFAULT_MAX_BATCH_MESSAGES;
  }

  async observe(message: DiscordMessage): Promise<void> {
    if (this.disposed || message.author.bot) return;

    try {
      await this.options.store.ensure(message.author.id, identityOf(message.author));
    } catch (error) {
      this.logger.warn(
        { err: error, event: "user_memory_ensure_failed", userId: message.author.id },
        "Failed to create user memory",
      );
      return;
    }

    this.enqueue(message);
  }

  dispose(): void {
    this.disposed = true;
    for (const queue of this.queues.values()) {
      if (queue.idleTimer) clearTimeout(queue.idleTimer);
      if (queue.maxAgeTimer) clearTimeout(queue.maxAgeTimer);
    }
    this.queues.clear();
  }

  private enqueue(message: DiscordMessage): void {
    if (this.disposed) return;

    const userId = message.author.id;
    let queue = this.queues.get(userId);
    if (!queue) {
      queue = {
        messages: [],
        processing: false,
      };
      this.queues.set(userId, queue);
    }

    queue.messages.push(message);
    if (queue.messages.length >= this.maxBatchMessages) {
      this.scheduleProcessing(userId);
      return;
    }

    this.resetIdleTimer(userId, queue);
    if (!queue.maxAgeTimer) {
      queue.maxAgeTimer = setTimeout(
        () => this.scheduleProcessing(userId),
        this.maxBatchAgeSeconds * 1_000,
      );
    }
  }

  private scheduleProcessing(userId: string): void {
    const queue = this.queues.get(userId);
    if (!queue || this.disposed) return;

    if (queue.idleTimer) {
      clearTimeout(queue.idleTimer);
      queue.idleTimer = undefined;
    }
    if (queue.maxAgeTimer) {
      clearTimeout(queue.maxAgeTimer);
      queue.maxAgeTimer = undefined;
    }

    void this.options.taskCoordinator.run(() => this.processUser(userId));
  }

  private async processUser(userId: string): Promise<void> {
    const queue = this.queues.get(userId);
    if (!queue || queue.processing || queue.messages.length === 0) return;

    queue.processing = true;
    const messages = queue.messages.splice(0, this.maxBatchMessages);
    const startedAt = Date.now();
    let failed = false;

    try {
      const before = await this.options.store.read(userId);
      if (!before) {
        this.logger.warn(
          { event: "user_memory_processing_missing", userId },
          "User memory disappeared before processing",
        );
        return;
      }

      const patch = await this.options.processor.process(before, messages.map(toUserMemoryMessage));
      if (Object.keys(patch).length > 0) {
        const current = await this.options.store.read(userId);
        if (current?.updatedAt === before.updatedAt) {
          const lastMessage = messages.at(-1);
          if (!lastMessage) return;
          await this.options.store.update(userId, identityOf(lastMessage.author), patch);
          this.logger.info(
            {
              durationMs: Date.now() - startedAt,
              event: "user_memory_processed",
              messageCount: messages.length,
              userId,
            },
            "Processed user memory",
          );
        } else {
          this.logger.info(
            {
              event: "user_memory_processing_skipped_stale",
              userId,
            },
            "Skipped user memory update because the memory changed during processing",
          );
        }
      }
    } catch (error) {
      failed = true;
      queue.messages.unshift(...messages);
      this.logger.warn(
        {
          durationMs: Date.now() - startedAt,
          err: error,
          event: "user_memory_processing_failed",
          messageCount: messages.length,
          userId,
        },
        "Failed to process user memory",
      );
    } finally {
      queue.processing = false;
      if (this.disposed || queue.messages.length === 0) {
        this.queues.delete(userId);
      } else if (failed) {
        this.resetIdleTimer(userId, queue);
        queue.maxAgeTimer = setTimeout(
          () => this.scheduleProcessing(userId),
          this.maxBatchAgeSeconds * 1_000,
        );
      } else {
        this.scheduleProcessing(userId);
      }
    }
  }

  private resetIdleTimer(userId: string, queue: UserMemoryQueue): void {
    if (queue.idleTimer) clearTimeout(queue.idleTimer);
    queue.idleTimer = setTimeout(() => this.scheduleProcessing(userId), this.idleSeconds * 1_000);
  }
}

function identityOf(user: DiscordUser): UserMemoryIdentity {
  return { username: user.username, displayName: user.displayName };
}

function toUserMemoryMessage(message: DiscordMessage): UserMemoryMessage {
  return {
    id: message.id,
    channelId: message.channelId,
    ...(message.channelName ? { channelName: message.channelName } : {}),
    occurredAt: message.occurredAt,
    content: formatDiscordMessage(message),
  };
}
