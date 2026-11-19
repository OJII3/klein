import type { Logger } from "pino";

import { formatDiscordMessage, type DiscordMessage } from "@modules/discord/domain/discord-message";
import { IdleBatchQueue } from "@app/idle-batch-queue";
import type { TaskCoordinator } from "@app/task-coordinator";
import { renderSharedMemoryContext } from "../domain/shared-memory-context-renderer";
import {
  sharedMemoryScopeKey,
  type SharedMemoryLocation,
  type SharedMemoryMessage,
  type SharedMemoryScope,
  type SharedMemoryScopeState,
  type SharedMemorySummary,
} from "../domain/shared-memory";
import type { SharedMemoryProcessor } from "../ports/shared-memory-processor";
import type { SharedMemoryReader, SharedMemoryStore } from "../ports/shared-memory-store";

export interface SharedMemoryCoordinatorOptions {
  readonly store: SharedMemoryStore;
  readonly idleSeconds: number;
  readonly maxBatchAgeSeconds: number;
  readonly maxBatchMessages: number;
  readonly logger: Logger;
  readonly processor: SharedMemoryProcessor;
  readonly taskCoordinator: TaskCoordinator;
}

export class SharedMemoryCoordinator implements SharedMemoryReader {
  private readonly logger: Logger;
  private readonly queue: IdleBatchQueue<string, DiscordMessage>;
  private readonly guildOperations = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(private readonly options: SharedMemoryCoordinatorOptions) {
    this.logger = options.logger.child({ component: "memory-coordinator" });
    this.queue = new IdleBatchQueue({
      idleSeconds: options.idleSeconds,
      maxBatchAgeSeconds: options.maxBatchAgeSeconds,
      maxBatchMessages: options.maxBatchMessages,
      keyOf: (message) => message.guildId,
      onError: ({ key: guildId, batch, error, durationMs }) => {
        this.logger.warn(
          {
            durationMs,
            err: error,
            event: "shared_memory_processing_failed",
            guildId,
            messageCount: batch.length,
          },
          "Failed to process shared memory",
        );
      },
      run: (guildId, messages) => this.processGuild(guildId, messages),
      taskCoordinator: options.taskCoordinator,
    });
  }

  enqueue(message: DiscordMessage): void {
    if (this.disposed) return;
    this.queue.enqueue(message);
  }

  async getContext(location: SharedMemoryLocation): Promise<string | undefined> {
    if (this.disposed) return undefined;

    try {
      const scopes: SharedMemoryScope[] = [
        { type: "guild" },
        { channelId: location.channelId, type: "channel" },
        ...(location.threadId
          ? [
              {
                channelId: location.channelId,
                threadId: location.threadId,
                type: "thread" as const,
              },
            ]
          : []),
      ];
      const states = await Promise.all(
        scopes.map(async (scope) => ({
          memory: await this.options.store.read(location.guildId, scope),
          scope,
        })),
      );
      return renderSharedMemoryContext(states);
    } catch (error) {
      this.logger.warn(
        { err: error, event: "shared_memory_context_read_failed", guildId: location.guildId },
        "Failed to read shared memory context",
      );
      return undefined;
    }
  }

  async listGuilds(): Promise<readonly SharedMemorySummary[]> {
    if (this.disposed) return [];

    const guildIds = await this.options.store.listGuildIds();
    const summaries = await Promise.all(
      guildIds.map(async (guildId): Promise<SharedMemorySummary | undefined> => {
        const files = await this.options.store.listFiles(guildId);
        if (files.length === 0) return undefined;
        return {
          guildId,
          itemCount: files.reduce(
            (total, file) => total + file.facts.length + file.preferences.length,
            0,
          ),
          updatedAt: files.reduce<string | null>(
            (latest, file) =>
              latest === null || file.updatedAt > latest ? file.updatedAt : latest,
            null,
          ),
        };
      }),
    );

    return summaries.filter((summary): summary is SharedMemorySummary => summary !== undefined);
  }

  async readGuild(guildId: string) {
    if (this.disposed) return { files: [], guildId };
    return { files: await this.options.store.listFiles(guildId), guildId };
  }

  writeFile(guildId: string, scope: SharedMemoryScope, content: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Memory coordinator is disposed"));
    return this.runGuildOperation(guildId, () =>
      this.options.store.writeContent(guildId, scope, content),
    );
  }

  deleteFile(guildId: string, scope: SharedMemoryScope): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Memory coordinator is disposed"));
    return this.runGuildOperation(guildId, () => this.options.store.delete(guildId, scope));
  }

  dispose(): void {
    this.disposed = true;
    this.queue.dispose();
  }

  async flush(): Promise<void> {
    if (this.disposed) return;
    await this.queue.flush();
  }

  private processGuild(guildId: string, messages: readonly DiscordMessage[]): Promise<void> {
    const startedAt = Date.now();
    return this.runGuildOperation(guildId, async () => {
      const states = await this.readScopeStates(guildId, messages);
      await this.options.processor.process(
        guildId,
        states,
        messages.map((message) => toSharedMemoryMessage(message)),
      );

      this.logger.info(
        {
          durationMs: Date.now() - startedAt,
          event: "shared_memory_processed",
          guildId,
          messageCount: messages.length,
          scopeCount: states.length,
        },
        "Processed shared memory",
      );
    });
  }

  private async readScopeStates(
    guildId: string,
    messages: readonly DiscordMessage[],
  ): Promise<SharedMemoryScopeState[]> {
    const scopes = new Map<string, SharedMemoryScope>();
    const guildScope: SharedMemoryScope = { type: "guild" };
    scopes.set(sharedMemoryScopeKey(guildScope), guildScope);

    for (const message of messages) {
      const channelId = message.parentChannelId ?? message.channelId;
      const channelScope: SharedMemoryScope = { channelId, type: "channel" };
      scopes.set(sharedMemoryScopeKey(channelScope), channelScope);

      if (message.threadId) {
        const threadScope: SharedMemoryScope = {
          channelId,
          threadId: message.threadId,
          type: "thread",
        };
        scopes.set(sharedMemoryScopeKey(threadScope), threadScope);
      }
    }

    return Promise.all(
      [...scopes.values()].map(async (scope) => ({
        memory: await this.options.store.read(guildId, scope),
        scope,
      })),
    );
  }

  private runGuildOperation(guildId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.guildOperations.get(guildId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tracked = current.then(
      () => undefined,
      () => undefined,
    );
    this.guildOperations.set(guildId, tracked);
    void tracked.finally(() => {
      if (this.guildOperations.get(guildId) === tracked) {
        this.guildOperations.delete(guildId);
      }
    });
    return current;
  }
}

function toSharedMemoryMessage(message: DiscordMessage): SharedMemoryMessage {
  return {
    channelId: message.channelId,
    content: formatDiscordMessage(message),
    id: message.id,
    ...(message.parentChannelId ? { parentChannelId: message.parentChannelId } : {}),
    ...(message.threadId ? { threadId: message.threadId } : {}),
  };
}
