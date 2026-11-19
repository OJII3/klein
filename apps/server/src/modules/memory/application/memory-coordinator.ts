import type { Logger } from "pino";

import { formatDiscordMessage, type DiscordMessage } from "@modules/discord/domain/discord-message";
import { IdleBatchQueue } from "@app/idle-batch-queue";
import type { TaskCoordinator } from "@app/task-coordinator";
import { renderGuildMemoryContext } from "../domain/guild-memory-context-renderer";
import {
  guildMemoryScopeKey,
  type GuildMemoryLocation,
  type GuildMemoryMessage,
  type GuildMemoryScope,
  type GuildMemoryScopeState,
  type GuildMemorySummary,
} from "../domain/guild-memory";
import type { MemoryProcessor } from "../ports/memory-processor";
import type { GuildMemoryReader, GuildMemoryStore } from "../ports/guild-memory-store";

export interface MemoryCoordinatorOptions {
  readonly store: GuildMemoryStore;
  readonly idleSeconds: number;
  readonly maxBatchAgeSeconds: number;
  readonly maxBatchMessages: number;
  readonly logger: Logger;
  readonly processor: MemoryProcessor;
  readonly taskCoordinator: TaskCoordinator;
}

export class MemoryCoordinator implements GuildMemoryReader {
  private readonly logger: Logger;
  private readonly queue: IdleBatchQueue<string, DiscordMessage>;
  private readonly guildOperations = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(private readonly options: MemoryCoordinatorOptions) {
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
            event: "guild_memory_processing_failed",
            guildId,
            messageCount: batch.length,
          },
          "Failed to process guild memory",
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

  async getContext(location: GuildMemoryLocation): Promise<string | undefined> {
    if (this.disposed) return undefined;

    try {
      const scopes: GuildMemoryScope[] = [
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
      return renderGuildMemoryContext(states);
    } catch (error) {
      this.logger.warn(
        { err: error, event: "guild_memory_context_read_failed", guildId: location.guildId },
        "Failed to read guild memory context",
      );
      return undefined;
    }
  }

  async listGuilds(): Promise<readonly GuildMemorySummary[]> {
    if (this.disposed) return [];

    const guildIds = await this.options.store.listGuildIds();
    const summaries = await Promise.all(
      guildIds.map(async (guildId): Promise<GuildMemorySummary | undefined> => {
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

    return summaries.filter((summary): summary is GuildMemorySummary => summary !== undefined);
  }

  async readGuild(guildId: string) {
    if (this.disposed) return { files: [], guildId };
    return { files: await this.options.store.listFiles(guildId), guildId };
  }

  writeFile(guildId: string, scope: GuildMemoryScope, content: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Memory coordinator is disposed"));
    return this.runGuildOperation(guildId, () =>
      this.options.store.writeContent(guildId, scope, content),
    );
  }

  deleteFile(guildId: string, scope: GuildMemoryScope): Promise<void> {
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
        messages.map((message) => toGuildMemoryMessage(message)),
      );

      this.logger.info(
        {
          durationMs: Date.now() - startedAt,
          event: "guild_memory_processed",
          guildId,
          messageCount: messages.length,
          scopeCount: states.length,
        },
        "Processed guild memory",
      );
    });
  }

  private async readScopeStates(
    guildId: string,
    messages: readonly DiscordMessage[],
  ): Promise<GuildMemoryScopeState[]> {
    const scopes = new Map<string, GuildMemoryScope>();
    const guildScope: GuildMemoryScope = { type: "guild" };
    scopes.set(guildMemoryScopeKey(guildScope), guildScope);

    for (const message of messages) {
      const channelId = message.parentChannelId ?? message.channelId;
      const channelScope: GuildMemoryScope = { channelId, type: "channel" };
      scopes.set(guildMemoryScopeKey(channelScope), channelScope);

      if (message.threadId) {
        const threadScope: GuildMemoryScope = {
          channelId,
          threadId: message.threadId,
          type: "thread",
        };
        scopes.set(guildMemoryScopeKey(threadScope), threadScope);
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

function toGuildMemoryMessage(message: DiscordMessage): GuildMemoryMessage {
  return {
    channelId: message.channelId,
    content: formatDiscordMessage(message),
    id: message.id,
    ...(message.parentChannelId ? { parentChannelId: message.parentChannelId } : {}),
    ...(message.threadId ? { threadId: message.threadId } : {}),
  };
}
