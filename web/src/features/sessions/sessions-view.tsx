import type { PiSessionEvent, SessionSummary } from "../../api";
import { EmptyState, ErrorNotice, LoadingState } from "../../components/feedback";
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

  return (
    <section className="flex flex-col gap-5" aria-labelledby="sessions-heading">
      <ViewHeader
        count={`${sessions.length.toLocaleString("ja-JP")} 件`}
        description="Discord のチャンネルごとに残った Pi の会話記録。"
        headingId="sessions-heading"
        title="Pi セッション"
      />

      {error && <ErrorNotice message={error} onRetry={onRetry} />}
      {loading && sessions.length === 0 ? (
        <LoadingState />
      ) : sessions.length === 0 ? (
        <EmptyState>セッションがまだありません</EmptyState>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[19rem_minmax(0,1fr)] lg:items-start">
          <div className="lg:sticky lg:top-8">
            <label className="flex flex-col gap-1.5 lg:hidden">
              <span className="text-xs text-ink-faint">セッション</span>
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
                    {truncateMiddle(session.firstMessage || session.channelKey, 32)} /{" "}
                    {formatCompactTimestamp(session.modified)}
                  </option>
                ))}
              </select>
            </label>

            <div className="hidden lg:block">
              <div className="flex items-baseline justify-between px-1 pb-2">
                <span className="text-xs text-ink-faint">セッション</span>
                <span className="font-mono text-[0.62rem] text-ink-faint">
                  {sessions.length} 件を表示
                </span>
              </div>
              <div
                aria-label="セッション一覧"
                className="max-h-[calc(100vh-14rem)] overflow-y-auto border-t border-rule"
              >
                {sessions.map((session) => {
                  const selected = selectedSession?.id === session.id;
                  return (
                    <button
                      key={session.id}
                      aria-current={selected ? "true" : undefined}
                      className={`block w-full border-b border-rule border-l-2 py-3 pr-2 pl-3 text-left transition-colors ${
                        selected
                          ? "border-l-brass bg-night-900/70"
                          : "border-l-transparent hover:bg-night-850/60"
                      }`}
                      onClick={() => onSelect(session.id)}
                      type="button"
                    >
                      <span
                        className={`block truncate text-[0.82rem] leading-6 ${
                          selected ? "text-brass-soft" : "text-ink"
                        }`}
                      >
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
              <div className="flex justify-center pt-3">
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
                  <p className="font-mono text-[0.62rem] text-ink-faint">
                    これより古いセッションはありません
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="min-w-0">
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
