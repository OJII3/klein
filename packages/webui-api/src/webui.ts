import type {
  GuildMemoryEditor,
  MemoryScopeReader,
  UserMemoryEditor,
  UserMemoryReader,
} from "./memory";
import type {
  ChannelNameReader,
  ToolUsageReader,
  ViewerLogReader,
  ViewerSessionReader,
} from "./viewer-readers";

export interface WebUiLogger {
  error(object: unknown, message?: string): void;
}

export interface WebUiDependencies {
  readonly displayName: string;
  readonly channelNames?: ChannelNameReader;
  readonly memory?: MemoryScopeReader;
  readonly memoryEditor?: GuildMemoryEditor;
  readonly userMemory?: UserMemoryReader;
  readonly userMemoryEditor?: UserMemoryEditor;
  readonly pinoLogs: ViewerLogReader;
  readonly piSessions: ViewerSessionReader;
  readonly toolUsage: ToolUsageReader;
  readonly logger?: WebUiLogger;
}
