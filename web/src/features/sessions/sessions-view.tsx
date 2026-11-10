import type { PiSessionEvent, SessionSummary } from "../../api";
import { EmptyState, ErrorNotice, LoadingState } from "../../components/feedback";
import { Stat, StatStrip } from "../../components/stats";
import { ViewHeader } from "../../components/view-header";
import { channelLabel, formatCompactTimestamp, truncateMiddle } from "../../lib/format";
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
  const selectableSessions = [
    ...(selectedSession && !sessions.some((session) => session.id === selectedSession.id)
      ? [selectedSession]
      : []),
    ...sessions,
  ];
  const totalMessages = sessions.reduce((sum, session) => sum + session.messageCount, 0);

  return (
    <section className="flex flex-col gap-4" aria-labelledby="sessions-heading">
      <ViewHeader headingId="sessions-heading" title="Pi セッション">
        <StatStrip>
          <Stat label="セッション" value={sessions.length.toLocaleString("ja-JP")} />
          <Stat label="メッセージ" value={totalMessages.toLocaleString("ja-JP")} />
        </StatStrip>
      </ViewHeader>

      {error && <ErrorNotice message={error} onRetry={onRetry} />}
      {loading && sessions.length === 0 ? (
        <div className="card border border-base-300 bg-base-100">
          <LoadingState />
        </div>
      ) : sessions.length === 0 ? (
        <div className="card border border-base-300 bg-base-100">
          <EmptyState>セッションがまだありません</EmptyState>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)] lg:items-start">
          <div className="card overflow-hidden border border-base-300 bg-base-100 lg:sticky lg:top-[4.25rem]">
            <div className="border-b border-line p-3 lg:hidden">
              <label className="flex flex-col gap-1">
                <span className="text-[0.7rem] font-medium text-ink-soft">セッション</span>
                <select
                  className="select select-sm w-full"
                  onChange={(event) => onSelect((event.target as HTMLSelectElement).value)}
                  value={selectedSession?.id ?? ""}
                >
                  <option disabled value="">
                    セッションを選択
                  </option>
                  {selectableSessions.map((session) => (
                    <option key={session.id} value={session.id}>
                      {truncateMiddle(channelLabel(session), 24)}（
                      {formatCompactTimestamp(session.modified)}）
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="hidden items-center justify-between border-b border-line px-3 py-2 lg:flex">
              <span className="text-[0.7rem] font-medium text-ink-faint">セッション</span>
              <span className="font-mono text-[0.62rem] text-ink-faint">{sessions.length} 件</span>
            </div>

            <div className="hidden max-h-[calc(100vh-12rem)] overflow-y-auto lg:block">
              <ul className="menu menu-sm w-full flex-nowrap p-0 [--menu-active-bg:var(--color-green-soft)] [--menu-active-fg:var(--color-green-strong)]">
                {sessions.map((session) => {
                  const selected = selectedSession?.id === session.id;
                  return (
                    <li key={session.id}>
                      <button
                        aria-current={selected ? "true" : undefined}
                        className="w-full"
                        onClick={() => onSelect(session.id)}
                        type="button"
                      >
                        <span className="flex w-full min-w-0 flex-col items-stretch gap-0.5">
                          <span
                            className="truncate text-[0.8rem] font-medium text-ink"
                            title={session.channelKey}
                          >
                            {truncateMiddle(channelLabel(session), 40)}
                          </span>
                          <span className="flex items-baseline justify-between gap-2 font-mono text-[0.62rem] text-ink-faint">
                            <span>{session.messageCount} メッセージ</span>
                            <span>{formatCompactTimestamp(session.modified)}</span>
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="flex justify-center border-t border-line px-3 py-2">
              {sessionsNextCursor ? (
                <button
                  className="btn btn-xs"
                  disabled={loadingMoreSessions}
                  onClick={onLoadMoreSessions}
                  type="button"
                >
                  {loadingMoreSessions ? "読み込み中…" : "古いセッションを読み込む"}
                </button>
              ) : (
                <p className="text-[0.62rem] text-ink-faint">これより古いセッションはありません</p>
              )}
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-3">
            {detailError && <ErrorNotice message={detailError} onRetry={onRetryDetail} />}
            <div className="card overflow-hidden border border-base-300 bg-base-100">
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
        </div>
      )}
    </section>
  );
}
