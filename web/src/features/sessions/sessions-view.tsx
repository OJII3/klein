import type { PiSessionEvent, SessionSummary } from "../../api";
import { EmptyState, ErrorNotice, LoadingState } from "../../components/feedback";
import { Stat, StatStrip } from "../../components/stats";
import { ViewHeader } from "../../components/view-header";
import { formatCompactTimestamp, truncateMiddle } from "../../lib/format";
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
        <div className="panel">
          <LoadingState />
        </div>
      ) : sessions.length === 0 ? (
        <div className="panel">
          <EmptyState>セッションがまだありません</EmptyState>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)] lg:items-start">
          <div className="panel overflow-hidden lg:sticky lg:top-[4.25rem]">
            <div className="border-b border-line p-3 lg:hidden">
              <label className="flex flex-col gap-1">
                <span className="text-[0.7rem] font-medium text-ink-soft">セッション</span>
                <select
                  className="field"
                  onChange={(event) => onSelect((event.target as HTMLSelectElement).value)}
                  value={selectedSession?.id ?? ""}
                >
                  <option disabled value="">
                    セッションを選択
                  </option>
                  {selectableSessions.map((session) => (
                    <option key={session.id} value={session.id}>
                      {truncateMiddle(session.firstMessage || session.channelKey, 32)}（
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

            <div className="hidden max-h-[calc(100vh-12rem)] divide-y divide-line overflow-y-auto lg:block">
              {sessions.map((session) => {
                const selected = selectedSession?.id === session.id;
                return (
                  <button
                    key={session.id}
                    aria-current={selected ? "true" : undefined}
                    className={`block w-full border-l-2 px-3 py-2.5 text-left transition-colors ${
                      selected
                        ? "border-l-green bg-green-soft/60"
                        : "border-l-transparent hover:bg-surface-muted"
                    }`}
                    onClick={() => onSelect(session.id)}
                    type="button"
                  >
                    <span className="block truncate text-[0.8rem] font-medium text-ink">
                      {session.firstMessage || "無題のセッション"}
                    </span>
                    <span
                      className="mt-0.5 block truncate font-mono text-[0.62rem] text-ink-faint"
                      title={session.channelKey}
                    >
                      {truncateMiddle(session.channelKey, 40)}
                    </span>
                    <span className="mt-1 flex items-baseline justify-between gap-2 font-mono text-[0.62rem] text-ink-faint">
                      <span>{session.messageCount} メッセージ</span>
                      <span>{formatCompactTimestamp(session.modified)}</span>
                    </span>
                  </button>
                );
              })}
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
            <div className="panel overflow-hidden">
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
