import type { Logger } from "pino";

import type { MemoryScopeEditor, MemoryScopeReader } from "@modules/memory/domain/memory";
import type { UserMemoryEditor, UserMemoryReader } from "@modules/user-memory/domain/user-memory";
import type {
  ChannelNameReader,
  ToolUsageReader,
  ViewerLogReader,
  ViewerSessionReader,
} from "./viewer-readers";

export interface WebUiDependencies {
  readonly displayName: string;
  readonly channelNames?: ChannelNameReader;
  readonly memory?: MemoryScopeReader;
  readonly memoryEditor?: MemoryScopeEditor;
  readonly userMemory?: UserMemoryReader;
  readonly userMemoryEditor?: UserMemoryEditor;
  readonly pinoLogs: ViewerLogReader;
  readonly piSessions: ViewerSessionReader;
  readonly toolUsage: ToolUsageReader;
  readonly logger?: Logger;
}
