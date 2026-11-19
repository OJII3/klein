export type GuildMemoryScope =
  | { readonly type: "guild" }
  | { readonly type: "channel"; readonly channelId: string }
  | { readonly type: "thread"; readonly channelId: string; readonly threadId: string };

export interface GuildMemory {
  readonly facts: readonly string[];
  readonly preferences: readonly string[];
}

export interface GuildMemoryFile extends GuildMemory {
  readonly scope: GuildMemoryScope;
  readonly content: string;
  readonly updatedAt: string;
}

export interface GuildMemorySummary {
  readonly guildId: string;
  readonly itemCount: number;
  readonly updatedAt: string | null;
}

export interface GuildMemoryScopeState {
  readonly scope: GuildMemoryScope;
  readonly memory: GuildMemory;
}

export interface GuildMemoryMessage {
  readonly id: string;
  readonly channelId: string;
  readonly parentChannelId?: string;
  readonly threadId?: string;
  readonly content: string;
}

export interface GuildMemoryLocation {
  readonly guildId: string;
  readonly channelId: string;
  readonly threadId?: string;
}

const GUILD_MEMORY_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

export function isValidGuildMemoryId(value: string): boolean {
  return GUILD_MEMORY_ID_PATTERN.test(value);
}

export function guildMemoryScopeKey(scope: GuildMemoryScope): string {
  switch (scope.type) {
    case "guild":
      return "guild";
    case "channel":
      return `channel:${scope.channelId}`;
    case "thread":
      return `thread:${scope.channelId}:${scope.threadId}`;
    default: {
      const exhaustive: never = scope;
      throw new Error(`Unsupported guild memory scope: ${String(exhaustive)}`);
    }
  }
}

export function guildMemoryRelativePath(scope: GuildMemoryScope): string {
  switch (scope.type) {
    case "guild":
      return "MEMORY.md";
    case "channel":
      return `${scope.channelId}/MEMORY.md`;
    case "thread":
      return `${scope.channelId}/${scope.threadId}/MEMORY.md`;
    default: {
      const exhaustive: never = scope;
      throw new Error(`Unsupported guild memory scope: ${String(exhaustive)}`);
    }
  }
}
