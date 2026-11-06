import type { PiSessionEvent, SessionSummary } from "../../api";
import { EmptyState } from "../../components/feedback";
import { JsonValue } from "../../components/json-value";
import {
  formatClockSeconds,
  formatCompactTimestamp,
  formatTimestamp,
  truncateMiddle,
} from "../../lib/format";

interface SessionTimelineProps {
  events: PiSessionEvent[];
  loadingMore: boolean;
  nextCursor: string | null;
  onLoadMore: () => void;
  session: SessionSummary;
}

function roleTone(role: string | undefined): string {
  switch (role) {
    case "user":
      return "bg-blue-soft text-blue";
    case "assistant":
      return "bg-green-soft text-green-strong";
    case "tool":
      return "bg-surface-muted text-ink-soft";
    default:
      return "bg-surface-muted text-ink-faint";
  }
}

function EventContent({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return (
      <p className="mt-1.5 max-w-[60rem] text-[0.82rem] leading-6 break-words whitespace-pre-wrap text-ink-soft">
        {value}
      </p>
    );
  }

  return (
    <div className="mt-2 max-w-[60rem]">
      <JsonValue value={value} />
    </div>
  );
}

export function SessionTimeline({
  events,
  loadingMore,
  nextCursor,
  onLoadMore,
  session,
}: SessionTimelineProps) {
  return (
    <div className="flex min-w-0 flex-col">
      <header className="border-b border-line px-4 py-4">
        <h2 className="text-[1.05rem] leading-snug font-semibold text-ink">
          {session.firstMessage || truncateMiddle(session.channelKey, 48)}
        </h2>
        <p
          className="mt-1 truncate font-mono text-[0.64rem] text-ink-faint"
          title={session.channelKey}
        >
          {session.channelKey}
        </p>
        <dl className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-[0.68rem]">
          <div className="flex gap-1.5">
            <dt className="text-ink-faint">メッセージ</dt>
            <dd className="font-mono text-ink-soft">{session.messageCount}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-ink-faint">開始</dt>
            <dd className="font-mono text-ink-soft">{formatCompactTimestamp(session.created)}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-ink-faint">更新</dt>
            <dd className="font-mono text-ink-soft">{formatCompactTimestamp(session.modified)}</dd>
          </div>
        </dl>
      </header>

      {events.length === 0 ? (
        <EmptyState>イベントがありません</EmptyState>
      ) : (
        <div className="divide-y divide-line">
          {events.map((event) => (
            <article
              className="grid gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[4.5rem_minmax(0,1fr)]"
              key={event.id}
            >
              <time
                className="font-mono text-[0.66rem] text-ink-faint sm:pt-0.5"
                dateTime={event.timestamp}
                title={formatTimestamp(event.timestamp)}
              >
                {formatClockSeconds(event.timestamp)}
              </time>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  {event.role && (
                    <span
                      className={`rounded px-1.5 py-0.5 text-[0.62rem] font-medium ${roleTone(
                        event.role,
                      )}`}
                    >
                      {event.role}
                    </span>
                  )}
                  <span className="font-mono text-[0.63rem] text-ink-faint">{event.kind}</span>
                </div>
                {event.errorMessage && (
                  <div
                    className="mt-2 rounded border border-red/25 bg-red-soft px-3 py-2 text-[0.8rem] leading-6 text-red"
                    role="alert"
                  >
                    {event.errorMessage}
                  </div>
                )}
                {event.content !== undefined &&
                  (!Array.isArray(event.content) || event.content.length > 0) && (
                    <EventContent value={event.content} />
                  )}
                {event.parentId && (
                  <p className="mt-1.5 font-mono text-[0.62rem] text-ink-faint">
                    parent {event.parentId}
                  </p>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {events.length > 0 && (
        <div className="flex justify-center border-t border-line px-3 py-2.5">
          {nextCursor ? (
            <button
              className="btn btn-xs"
              disabled={loadingMore}
              onClick={onLoadMore}
              type="button"
            >
              {loadingMore ? "読み込み中…" : "古いイベントを読み込む"}
            </button>
          ) : (
            <p className="text-[0.66rem] text-ink-faint">これより古いイベントはありません</p>
          )}
        </div>
      )}
    </div>
  );
}
