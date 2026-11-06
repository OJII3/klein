import type { PiSessionEvent, SessionSummary } from "../../api";
import { EmptyState } from "../../components/feedback";
import { JsonValue } from "../../components/json-value";
import { formatShortTimestamp, formatTimestamp, truncateMiddle } from "../../lib/format";

interface SessionTimelineProps {
  events: PiSessionEvent[];
  loadingMore: boolean;
  nextCursor: string | null;
  onLoadMore: () => void;
  session: SessionSummary;
}

export function SessionTimeline({
  events,
  loadingMore,
  nextCursor,
  onLoadMore,
  session,
}: SessionTimelineProps) {
  return (
    <div className="rounded-box border border-base-300 bg-base-200 p-4">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-lg font-bold" title={session.channelKey}>
              {truncateMiddle(session.channelKey, 48)}
            </h3>
            <p className="text-xs opacity-60">更新 {formatShortTimestamp(session.modified)}</p>
          </div>
          <div className="text-right">
            <p className="text-sm">{session.messageCount} メッセージ</p>
            <p className="text-xs opacity-60">開始 {formatTimestamp(session.created)}</p>
          </div>
        </div>
        {events.length === 0 ? (
          <EmptyState>イベントがありません</EmptyState>
        ) : (
          <div className="flex flex-col gap-4">
            {events.map((event) => (
              <div key={event.id} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="badge badge-sm badge-soft">{event.kind}</span>
                  {event.role && <span className="badge badge-sm badge-outline">{event.role}</span>}
                  <span className="text-xs opacity-60">{formatTimestamp(event.timestamp)}</span>
                </div>
                {event.errorMessage && (
                  <div
                    className="rounded-box border border-error/40 bg-error/10 p-3 text-sm text-error"
                    role="alert"
                  >
                    {event.errorMessage}
                  </div>
                )}
                {event.content !== undefined &&
                  (!Array.isArray(event.content) || event.content.length > 0) && (
                    <JsonValue value={event.content} />
                  )}
                {event.parentId && <p className="text-xs opacity-60">parent: {event.parentId}</p>}
              </div>
            ))}
          </div>
        )}
        {events.length > 0 && (
          <div className="flex justify-center">
            {nextCursor ? (
              <button
                className="btn btn-soft btn-primary btn-sm"
                disabled={loadingMore}
                onClick={onLoadMore}
                type="button"
              >
                {loadingMore ? "読み込み中…" : "古いイベントを読み込む"}
              </button>
            ) : (
              <p className="text-sm opacity-70">これより古いイベントはありません</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
