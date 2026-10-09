import type {
  PinoViewerEvent,
  ViewerPage,
  ViewerSessionDetail,
  ViewerSessionSummary,
} from "../domain/viewer-event";

export interface ViewerLogQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly level?: string;
  readonly q?: string;
  readonly channelId?: string;
  readonly event?: string;
}

export interface ViewerLogReader {
  list(query?: ViewerLogQuery): Promise<ViewerPage<PinoViewerEvent>>;
}

export interface ViewerSessionQuery {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ViewerSessionReader {
  list(query?: ViewerSessionQuery): Promise<ViewerPage<ViewerSessionSummary>>;
  get(sessionId: string, query?: ViewerSessionQuery): Promise<ViewerSessionDetail | undefined>;
}
