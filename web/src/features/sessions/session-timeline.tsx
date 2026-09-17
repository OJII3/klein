import type { PiSessionEvent, SessionSummary } from "../../api";
import { EmptyState } from "../../components/feedback";
import { JsonValue } from "../../components/json-value";
import { formatTimestamp } from "../../lib/format";

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
    <div className="timeline-panel">
      <div className="session-detail-heading">
        <div>
          <p className="eyebrow">{session.channelKey}</p>
          <h3>{session.firstMessage || "Pi session"}</h3>
        </div>
        <dl className="session-stats">
          <div>
            <dt>メッセージ</dt>
            <dd>{session.messageCount}</dd>
          </div>
          <div>
            <dt>開始</dt>
            <dd>{formatTimestamp(session.created)}</dd>
          </div>
        </dl>
      </div>
      {events.length === 0 ? (
        <EmptyState>イベントがありません</EmptyState>
      ) : (
        <ol className="timeline">
          {events.map((event) => (
            <li className="timeline-item" key={event.id}>
              <span className={`timeline-dot timeline-dot-${event.role ?? event.kind}`} />
              <article className="timeline-event">
                <header>
                  <div className="timeline-kind">
                    <span className="event-pill">{event.kind}</span>
                    {event.role && <span className="role-label">{event.role}</span>}
                  </div>
                  <time dateTime={event.timestamp}>{formatTimestamp(event.timestamp)}</time>
                </header>
                {event.errorMessage && (
                  <pre className="timeline-error" role="alert">
                    {event.errorMessage}
                  </pre>
                )}
                {event.content !== undefined &&
                  (!Array.isArray(event.content) || event.content.length > 0) && (
                    <JsonValue className="timeline-content" value={event.content} />
                  )}
                {event.parentId && <p className="timeline-parent">parent: {event.parentId}</p>}
              </article>
            </li>
          ))}
        </ol>
      )}
      {events.length > 0 && (
        <div className="pagination-row">
          {nextCursor ? (
            <button className="button" disabled={loadingMore} onClick={onLoadMore} type="button">
              {loadingMore ? "読み込み中…" : "古いイベントを読み込む"}
            </button>
          ) : (
            <span className="muted">これより古いイベントはありません</span>
          )}
        </div>
      )}
    </div>
  );
}
