import type {
  SharedMemoryEditor,
  MemoryScopeReader,
  UserMemoryEditor,
  UserMemoryReader,
} from "./memory";
import type { ProactivityReader } from "./proactivity";
import type { SkillReader } from "./skills";
import type {
  DiscordNameReader,
  ToolUsageReader,
  ViewerLogReader,
  ViewerSessionReader,
} from "./viewer-readers";

export interface WebUiLogger {
  error(object: unknown, message?: string): void;
}

export interface WebUiDependencies {
  readonly displayName: string;
  readonly channelNames?: DiscordNameReader;
  readonly guildNames?: DiscordNameReader;
  readonly memory?: MemoryScopeReader;
  readonly memoryEditor?: SharedMemoryEditor;
  readonly userMemory?: UserMemoryReader;
  readonly userMemoryEditor?: UserMemoryEditor;
  readonly pinoLogs: ViewerLogReader;
  readonly piSessions: ViewerSessionReader;
  readonly toolUsage: ToolUsageReader;
  readonly proactivity?: ProactivityReader;
  readonly skills?: SkillReader;
  readonly logger?: WebUiLogger;
}
