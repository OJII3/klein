import type { PiSessionEvent, SessionSummary } from "../../api";
import { EmptyState, ErrorNotice, LoadingState } from "../../components/feedback";
import { formatTimestamp } from "../../lib/format";
import { SessionTimeline } from "./session-timeline";

interface SessionsViewProps {
  sessions: SessionSummary[];
  sessionsNextCursor: string | null;
  selectedSession: SessionSummary | null;
  events: PiSessionEvent[];
  nextCursor: string | null;
  loading: boolean;
  loadingMoreSessions: boolean;
  loadingDetail: boolean;
  loadingMoreDetail: boolean;
  error: string | null;
  detailError: string | null;
  onSelect: (id: string) => void;
  onRetry: () => void;
  onLoadMoreSessions: () => void;
  onRetryDetail: () => void;
  onLoadMoreDetail: () => void;
}

export function SessionsView({
  sessions,
  sessionsNextCursor,
  selectedSession,
  events,
  nextCursor,
  loading,
  loadingMoreSessions,
  loadingDetail,
  loadingMoreDetail,
  error,
  detailError,
  onSelect,
  onRetry,
  onLoadMoreSessions,
  onRetryDetail,
  onLoadMoreDetail,
}: SessionsViewProps) {
  return (
    <section className="view-section" aria-labelledby="sessions-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">PI / SESSION JSONL</p>
          <h2 id="sessions-heading">Piセッション</h2>
        </div>
        <span className="result-count">{sessions.length.toLocaleString("ja-JP")} 件</span>
      </div>

      {error && <ErrorNotice message={error} onRetry={onRetry} />}
      {loading && sessions.length === 0 ? (
        <LoadingState />
      ) : sessions.length === 0 ? (
        <EmptyState>セッションがまだありません</EmptyState>
      ) : (
        <div className="sessions-layout">
          <div className="session-list" aria-label="セッション一覧">
            {sessions.map((session) => (
              <button
                className={`session-list-item${selectedSession?.id === session.id ? " is-selected" : ""}`}
                key={session.id}
                onClick={() => onSelect(session.id)}
                type="button"
              >
                <span className="session-list-topline">
                  <span className="session-channel">{session.channelKey}</span>
                  <span className="session-count">{session.messageCount} msg</span>
                </span>
                <strong>{session.firstMessage || "（メッセージなし）"}</strong>
                <time dateTime={session.modified}>更新 {formatTimestamp(session.modified)}</time>
              </button>
            ))}
            <div className="pagination-row">
              {sessionsNextCursor ? (
                <button
                  className="button"
                  disabled={loadingMoreSessions}
                  onClick={onLoadMoreSessions}
                  type="button"
                >
                  {loadingMoreSessions ? "読み込み中…" : "古いセッションを読み込む"}
                </button>
              ) : (
                <span className="muted">これより古いセッションはありません</span>
              )}
            </div>
          </div>

          <div className="session-detail">
            {detailError && <ErrorNotice message={detailError} onRetry={onRetryDetail} />}
            {loadingDetail ? (
              <LoadingState label="セッションを読み込み中…" />
            ) : selectedSession ? (
              <SessionTimeline
                events={events}
                loadingMore={loadingMoreDetail}
                nextCursor={nextCursor}
                onLoadMore={onLoadMoreDetail}
                session={selectedSession}
              />
            ) : (
              <EmptyState>セッションを選択してください</EmptyState>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
