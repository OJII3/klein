import type { PiSessionEvent, SessionSummary } from "../../api";
import { EmptyState } from "../../components/feedback";
import { JsonValue } from "../../components/json-value";
import { formatClockSeconds, formatTimestamp, truncateMiddle } from "../../lib/format";

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
      return "text-sky";
    case "assistant":
      return "text-brass-soft";
    case "tool":
      return "text-moss";
    default:
      return "text-ink-faint";
  }
}

function EventContent({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return (
      <p className="mt-1.5 text-[0.83rem] leading-7 break-words whitespace-pre-wrap text-ink-soft">
        {value}
      </p>
    );
  }

  return (
    <div className="mt-2">
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
      <header className="border-b border-rule pb-5">
        <p className="truncate font-mono text-[0.66rem] text-ink-faint" title={session.channelKey}>
          {session.channelKey}
        </p>
        <h2 className="mt-2 text-[1.35rem] leading-snug text-ink">
          {session.firstMessage || truncateMiddle(session.channelKey, 48)}
        </h2>
        <dl className="mt-3 flex flex-wrap gap-x-7 gap-y-1 text-[0.68rem]">
          <div className="flex gap-2">
            <dt className="text-ink-faint">メッセージ</dt>
            <dd className="font-mono text-ink-soft">{session.messageCount}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-ink-faint">開始</dt>
            <dd className="font-mono text-ink-soft">{formatTimestamp(session.created)}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-ink-faint">更新</dt>
            <dd className="font-mono text-ink-soft">{formatTimestamp(session.modified)}</dd>
          </div>
        </dl>
      </header>

      {events.length === 0 ? (
        <EmptyState>イベントがありません</EmptyState>
      ) : (
        <div className="flex flex-col divide-y divide-rule/60">
          {events.map((event) => (
            <article
              className="grid gap-x-4 gap-y-1 py-4 sm:grid-cols-[5.2rem_minmax(0,1fr)]"
              key={event.id}
            >
              <time
                className="font-mono text-[0.68rem] text-ink-faint sm:pt-0.5"
                dateTime={event.timestamp}
              >
                {formatClockSeconds(event.timestamp)}
              </time>
              <div className="min-w-0 max-w-[48rem]">
                <div className="flex flex-wrap items-baseline gap-2">
                  {event.role && (
                    <span className={`font-mono text-[0.66rem] ${roleTone(event.role)}`}>
                      {event.role}
                    </span>
                  )}
                  <span className="font-mono text-[0.66rem] text-ink-faint">{event.kind}</span>
                </div>
                {event.errorMessage && (
                  <div
                    className="mt-2 border-l-2 border-ember bg-ember/10 px-3 py-2 text-[0.8rem] leading-6 text-ember"
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
        <div className="flex justify-center py-4">
          {nextCursor ? (
            <button className="btn" disabled={loadingMore} onClick={onLoadMore} type="button">
              {loadingMore ? "読み込み中…" : "古いイベントを読み込む"}
            </button>
          ) : (
            <p className="font-mono text-[0.66rem] text-ink-faint">
              これより古いイベントはありません
            </p>
          )}
        </div>
      )}
    </div>
  );
}
