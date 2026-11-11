import type { Logger } from "pino";

import { formatDiscordMessage, type DiscordMessage } from "@modules/discord/domain/discord-message";
import { IdleBatchQueue } from "@app/idle-batch-queue";
import type { TaskCoordinator } from "@app/task-coordinator";
import { JsonMemoryStore, listMemoryGuildIds } from "../infrastructure/json-memory-store";
import { renderMemoryContext } from "../infrastructure/memory-context-renderer";
import { selectMemoryEntries } from "./memory-context-selector";
import { MemoryEntryNotFoundError } from "../domain/memory";
import type {
  GuildMemoryEditor,
  GuildMemoryReader,
  MemoryDocument,
  MemoryGuildSummary,
  MemoryLocation,
  MemoryMessage,
  MemoryProcessor,
} from "../domain/memory";

export interface MemoryCoordinatorOptions {
  readonly filePath: string;
  readonly idleSeconds: number;
  readonly maxBatchAgeSeconds: number;
  readonly maxBatchMessages: number;
  readonly logger: Logger;
  readonly processor: MemoryProcessor;
  readonly taskCoordinator: TaskCoordinator;
}

export class MemoryCoordinator implements GuildMemoryReader, GuildMemoryEditor {
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

  async getContext(location: MemoryLocation, query: string): Promise<string | undefined> {
    if (this.disposed) return undefined;

    try {
      const document = await this.read(location.guildId);
      const selectedDocument = selectMemoryEntries(document, query, { location });
      return selectedDocument.entries.length > 0
        ? renderMemoryContext(selectedDocument)
        : undefined;
    } catch (error) {
      this.logger.warn(
        { err: error, event: "guild_memory_context_read_failed", guildId: location.guildId },
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
    const store = new JsonMemoryStore(resolveMemoryFilePath(this.options.filePath, guildId));
    return store.read();
  }

  deleteEntry(guildId: string, entryId: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Memory coordinator is disposed"));

    return this.runGuildOperation(guildId, async () => {
      const store = new JsonMemoryStore(resolveMemoryFilePath(this.options.filePath, guildId));
      const document = await store.read();
      if (!document.entries.some((entry) => entry.id === entryId)) {
        throw new MemoryEntryNotFoundError({ guildId, type: "guild" }, entryId);
      }

      await store.apply([{ id: entryId, type: "delete" }], []);
    });
  }

  addRule(guildId: string, title: string, content: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Memory coordinator is disposed"));
    return this.runGuildOperation(guildId, async () => {
      const store = new JsonMemoryStore(resolveMemoryFilePath(this.options.filePath, guildId));
      await store.apply(
        [{ type: "add", kind: "rule", scope: { type: "guild" }, title, content }],
        [],
      );
    });
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
      const store = new JsonMemoryStore(resolveMemoryFilePath(this.options.filePath, guildId));
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
    });
  }

  private runGuildOperation(guildId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.guildOperations.get(guildId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tracked = current.then(
      () => undefined,
      () => undefined,
    );
    this.guildOperations.set(guildId, tracked);
    void tracked.then(() => {
      if (this.guildOperations.get(guildId) === tracked) {
        this.guildOperations.delete(guildId);
      }
    });
    return current;
  }
}

function toMemoryMessage(message: DiscordMessage): MemoryMessage {
  return {
    channelId: message.channelId,
    content: formatDiscordMessage(message),
    id: message.id,
    ...(message.parentChannelId ? { parentChannelId: message.parentChannelId } : {}),
    ...(message.threadId ? { threadId: message.threadId } : {}),
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
