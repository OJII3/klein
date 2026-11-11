import type { Logger } from "pino";

import { IdleBatchQueue } from "@app/idle-batch-queue";
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
  private readonly queue: IdleBatchQueue<string, DiscordMessage>;
  private disposed = false;

  constructor(private readonly options: UserMemoryCoordinatorOptions) {
    this.logger = options.logger.child({ component: "user-memory-coordinator" });
    this.queue = new IdleBatchQueue({
      idleSeconds: options.idleSeconds ?? DEFAULT_IDLE_SECONDS,
      maxBatchAgeSeconds: options.maxBatchAgeSeconds ?? DEFAULT_MAX_BATCH_AGE_SECONDS,
      maxBatchMessages: options.maxBatchMessages ?? DEFAULT_MAX_BATCH_MESSAGES,
      keyOf: (message) => (message.author.bot ? undefined : message.author.id),
      onError: ({ key: userId, batch, error, durationMs }) => {
        this.logger.warn(
          {
            durationMs,
            err: error,
            event: "user_memory_processing_failed",
            messageCount: batch.length,
            userId,
          },
          "Failed to process user memory",
        );
      },
      run: (userId, messages) => this.processUser(userId, messages),
      taskCoordinator: options.taskCoordinator,
    });
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

    this.queue.enqueue(message);
  }

  dispose(): void {
    this.disposed = true;
    this.queue.dispose();
  }

  async flush(): Promise<void> {
    if (this.disposed) return;
    await this.queue.flush();
  }

  private async processUser(userId: string, messages: readonly DiscordMessage[]): Promise<void> {
    const startedAt = Date.now();
    const before = await this.options.store.read(userId);
    if (!before) {
      this.logger.warn(
        { event: "user_memory_processing_missing", userId },
        "User memory disappeared before processing",
      );
      return;
    }

    const updated = await this.options.processor.process(
      userId,
      before,
      messages.map(toUserMemoryMessage),
    );
    if (!updated) return;

    const lastMessage = messages.at(-1);
    if (!lastMessage) return;
    await this.options.store.update(userId, identityOf(lastMessage.author), {
      displayName: before.displayName,
      nickname: updated.nickname ?? null,
      firstName: updated.firstName ?? null,
      lastName: updated.lastName ?? null,
      summary: updated.summary,
      impression: before.impression,
      facts: updated.facts,
      history: updated.history,
      inCommon: updated.inCommon,
      strengthening: updated.strengthening,
    });
    this.logger.info(
      {
        durationMs: Date.now() - startedAt,
        event: "user_memory_processed",
        messageCount: messages.length,
        userId,
      },
      "Processed user memory",
    );
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
