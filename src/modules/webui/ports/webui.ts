import type { Logger } from "pino";

import type { MemoryScopeEditor, MemoryScopeReader } from "@modules/memory/domain/memory";
import type { ToolUsageReader, ViewerLogReader, ViewerSessionReader } from "./viewer-readers";

export interface WebUiDependencies {
  readonly memory?: MemoryScopeReader;
  readonly memoryEditor?: MemoryScopeEditor;
  readonly pinoLogs: ViewerLogReader;
  readonly piSessions: ViewerSessionReader;
  readonly toolUsage: ToolUsageReader;
  readonly logger?: Logger;
}
