import type { Logger } from "pino";

import { formatDiscordMessage, type DiscordMessage } from "@modules/discord/domain/discord-message";
import type { TaskCoordinator } from "@app/task-coordinator";
import {
  listMemoryGuildIds,
  MarkdownMemoryStore,
  renderMemoryDocument,
} from "../infrastructure/markdown-memory-store";
import type {
  MemoryDocument,
  MemoryGuildSummary,
  MemoryMessage,
  MemoryProcessor,
  MemoryReader,
} from "../domain/memory";

interface GuildMemoryQueue {
  readonly messages: DiscordMessage[];
  processing: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  maxAgeTimer?: ReturnType<typeof setTimeout>;
}

export interface MemoryCoordinatorOptions {
  readonly filePath: string;
  readonly idleSeconds: number;
  readonly maxBatchAgeSeconds: number;
  readonly maxBatchMessages: number;
  readonly logger: Logger;
  readonly processor: MemoryProcessor;
  readonly taskCoordinator: TaskCoordinator;
}

export class MemoryCoordinator implements MemoryReader {
  private readonly logger: Logger;
  private readonly queues = new Map<string, GuildMemoryQueue>();
  private disposed = false;

  constructor(private readonly options: MemoryCoordinatorOptions) {
    this.logger = options.logger.child({ component: "memory-coordinator" });
  }

  enqueue(message: DiscordMessage): void {
    if (this.disposed || !message.guildId) return;

    const guildId = message.guildId;
    let queue = this.queues.get(guildId);
    if (!queue) {
      queue = {
        messages: [],
        processing: false,
      };
      this.queues.set(guildId, queue);
    }

    queue.messages.push(message);
    if (queue.messages.length >= this.options.maxBatchMessages) {
      this.scheduleProcessing(guildId);
      return;
    }

    this.resetIdleTimer(guildId, queue);
    if (!queue.maxAgeTimer) {
      queue.maxAgeTimer = setTimeout(
        () => this.scheduleProcessing(guildId),
        this.options.maxBatchAgeSeconds * 1_000,
      );
    }
  }

  async getContext(guildId: string): Promise<string | undefined> {
    if (this.disposed) return undefined;

    try {
      const document = await this.read(guildId);
      return document.entries.length > 0 ? renderMemoryDocument(document) : undefined;
    } catch (error) {
      this.logger.warn(
        { err: error, event: "guild_memory_context_read_failed", guildId },
        "Failed to read guild memory context",
      );
      return undefined;
    }
  }

  async listGuilds(): Promise<readonly MemoryGuildSummary[]> {
    if (this.disposed) return [];

    const guildIds = await listMemoryGuildIds(this.options.filePath);
    return Promise.all(
      guildIds.map(async (guildId) => {
        const document = await this.read(guildId);
        return {
          entryCount: document.entries.length,
          guildId,
          updatedAt: latestUpdatedAt(document),
        };
      }),
    );
  }

  async read(guildId: string): Promise<MemoryDocument> {
    const store = new MarkdownMemoryStore(resolveMemoryFilePath(this.options.filePath, guildId));
    return store.read();
  }

  dispose(): void {
    this.disposed = true;
    for (const queue of this.queues.values()) {
      if (queue.idleTimer) clearTimeout(queue.idleTimer);
      if (queue.maxAgeTimer) clearTimeout(queue.maxAgeTimer);
    }
    this.queues.clear();
  }

  private scheduleProcessing(guildId: string): void {
    const queue = this.queues.get(guildId);
    if (!queue || this.disposed) return;

    if (queue.idleTimer) {
      clearTimeout(queue.idleTimer);
      queue.idleTimer = undefined;
    }
    if (queue.maxAgeTimer) {
      clearTimeout(queue.maxAgeTimer);
      queue.maxAgeTimer = undefined;
    }

    void this.options.taskCoordinator.run(() => this.processGuild(guildId));
  }

  private async processGuild(guildId: string): Promise<void> {
    const queue = this.queues.get(guildId);
    if (!queue || queue.processing || queue.messages.length === 0) return;

    queue.processing = true;
    const messages = queue.messages.splice(0, this.options.maxBatchMessages);
    const startedAt = Date.now();
    let failed = false;

    try {
      const store = new MarkdownMemoryStore(resolveMemoryFilePath(this.options.filePath, guildId));
      const document = await store.read();
      const operations = await this.options.processor.process(
        document,
        messages.map(toMemoryMessage),
      );
      await store.apply(
        operations,
        messages.map((message) => message.id),
      );
      this.logger.info(
        {
          durationMs: Date.now() - startedAt,
          event: "guild_memory_processed",
          guildId,
          messageCount: messages.length,
          operationCount: operations.filter((operation) => operation.type !== "noop").length,
        },
        "Processed guild memory",
      );
    } catch (error) {
      failed = true;
      queue.messages.unshift(...messages);
      this.logger.warn(
        {
          durationMs: Date.now() - startedAt,
          err: error,
          event: "guild_memory_processing_failed",
          guildId,
          messageCount: messages.length,
        },
        "Failed to process guild memory",
      );
    } finally {
      queue.processing = false;
      if (queue.messages.length === 0 || this.disposed) {
        this.queues.delete(guildId);
      } else if (failed) {
        this.resetIdleTimer(guildId, queue);
        queue.maxAgeTimer = setTimeout(
          () => this.scheduleProcessing(guildId),
          this.options.maxBatchAgeSeconds * 1_000,
        );
      } else {
        this.scheduleProcessing(guildId);
      }
    }
  }

  private resetIdleTimer(guildId: string, queue: GuildMemoryQueue): void {
    if (queue.idleTimer) clearTimeout(queue.idleTimer);
    queue.idleTimer = setTimeout(
      () => this.scheduleProcessing(guildId),
      this.options.idleSeconds * 1_000,
    );
  }
}

function toMemoryMessage(message: DiscordMessage): MemoryMessage {
  return {
    channelId: message.channelId,
    content: formatDiscordMessage(message),
    id: message.id,
  };
}

function latestUpdatedAt(document: MemoryDocument): string | null {
  return document.entries.reduce<string | null>(
    (latest, entry) => (latest === null || entry.updatedAt > latest ? entry.updatedAt : latest),
    null,
  );
}

export function resolveMemoryFilePath(filePath: string, guildId: string): string {
  return filePath.replaceAll("{guildId}", guildId);
}
