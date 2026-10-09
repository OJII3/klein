import type { Logger } from "pino";

import type { MemoryEditor, MemoryReader } from "@modules/memory/domain/memory";
import type { ViewerLogReader, ViewerSessionReader } from "./viewer-readers";

export interface WebUiDependencies {
  readonly memory?: MemoryReader;
  readonly memoryEditor?: MemoryEditor;
  readonly pinoLogs: ViewerLogReader;
  readonly piSessions: ViewerSessionReader;
  readonly logger?: Logger;
}
