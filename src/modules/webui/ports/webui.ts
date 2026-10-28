import type { Logger } from "pino";

import type { MemoryScopeEditor, MemoryScopeReader } from "@modules/memory/domain/memory";
import type { ViewerLogReader, ViewerSessionReader } from "./viewer-readers";

export interface WebUiDependencies {
  readonly memory?: MemoryScopeReader;
  readonly memoryEditor?: MemoryScopeEditor;
  readonly pinoLogs: ViewerLogReader;
  readonly piSessions: ViewerSessionReader;
  readonly logger?: Logger;
}
