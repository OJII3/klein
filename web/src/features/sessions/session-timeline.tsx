import type { PiSessionEvent, SessionSummary } from "../../api.js";
import { EmptyState } from "../../components/feedback.js";
import { JsonValue } from "../../components/json-value.js";
import { formatTimestamp } from "../../lib/format.js";

interface SessionTimelineProps {
  events: PiSessionEvent[];
  session: SessionSummary;
}

export function SessionTimeline({ events, session }: SessionTimelineProps) {
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
                {event.content !== undefined && (
                  <JsonValue className="timeline-content" value={event.content} />
                )}
                {event.parentId && <p className="timeline-parent">parent: {event.parentId}</p>}
              </article>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
