export type SharedMemoryScope =
  | { readonly type: "guild" }
  | { readonly type: "channel"; readonly channelId: string }
  | { readonly type: "thread"; readonly channelId: string; readonly threadId: string };

export interface SharedMemory {
  readonly facts: readonly string[];
  readonly preferences: readonly string[];
}

export interface SharedMemoryFile extends SharedMemory {
  readonly scope: SharedMemoryScope;
  readonly content: string;
  readonly updatedAt: string;
}

export interface SharedMemorySummary {
  readonly guildId: string;
  readonly itemCount: number;
  readonly updatedAt: string | null;
}

export interface SharedMemoryScopeState {
  readonly scope: SharedMemoryScope;
  readonly memory: SharedMemory;
}

export interface SharedMemoryMessage {
  readonly id: string;
  readonly channelId: string;
  readonly parentChannelId?: string;
  readonly threadId?: string;
  readonly content: string;
}

export interface SharedMemoryLocation {
  readonly guildId: string;
  readonly channelId: string;
  readonly threadId?: string;
}

const SHARED_MEMORY_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

export function isValidSharedMemoryId(value: string): boolean {
  return SHARED_MEMORY_ID_PATTERN.test(value);
}

export function sharedMemoryScopeKey(scope: SharedMemoryScope): string {
  switch (scope.type) {
    case "guild":
      return "guild";
    case "channel":
      return `channel:${scope.channelId}`;
    case "thread":
      return `thread:${scope.channelId}:${scope.threadId}`;
    default: {
      const exhaustive: never = scope;
      throw new Error(`Unsupported shared memory scope: ${String(exhaustive)}`);
    }
  }
}

export function sharedMemoryRelativePath(scope: SharedMemoryScope): string {
  switch (scope.type) {
    case "guild":
      return "MEMORY.md";
    case "channel":
      return `${scope.channelId}/MEMORY.md`;
    case "thread":
      return `${scope.channelId}/${scope.threadId}/MEMORY.md`;
    default: {
      const exhaustive: never = scope;
      throw new Error(`Unsupported shared memory scope: ${String(exhaustive)}`);
    }
  }
}
