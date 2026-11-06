import type { PiSessionEvent, SessionSummary } from "../../api";
import { EmptyState, ErrorNotice, LoadingState } from "../../components/feedback";
import { formatShortTimestamp, truncateMiddle } from "../../lib/format";
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
    <section className="flex flex-col gap-4" aria-labelledby="sessions-heading">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-wider text-primary">PI / SESSION JSONL</p>
          <h2 className="text-2xl font-bold" id="sessions-heading">
            Piセッション
          </h2>
        </div>
        <p className="text-sm opacity-70">{sessions.length.toLocaleString("ja-JP")} 件</p>
      </div>
      {error && <ErrorNotice message={error} onRetry={onRetry} />}
      {loading && sessions.length === 0 ? (
        <LoadingState />
      ) : sessions.length === 0 ? (
        <EmptyState>セッションがまだありません</EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="md:col-span-1">
            <label className="flex flex-col gap-1 md:hidden">
              <span className="text-xs opacity-70">セッション</span>
              <select
                className="select w-full"
                onChange={(event) => onSelect((event.target as HTMLSelectElement).value)}
                value={selectedSession?.id ?? ""}
              >
                <option disabled value="">
                  セッションを選択
                </option>
                {selectableSessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {truncateMiddle(session.channelKey, 24)} ·{" "}
                    {formatShortTimestamp(session.modified)}
                  </option>
                ))}
              </select>
            </label>
            <div className="hidden rounded-box border border-base-300 bg-base-200 p-2 md:block">
              <div
                aria-label="セッション一覧"
                className="flex max-h-[560px] flex-col gap-2 overflow-auto"
              >
                {sessions.map((session) => {
                  const selected = selectedSession?.id === session.id;
                  return (
                    <button
                      key={session.id}
                      className={`w-full rounded-box border p-3 text-left transition ${
                        selected
                          ? "border-primary bg-primary/15"
                          : "border-base-300 bg-base-100 hover:bg-base-300/50"
                      }`}
                      onClick={() => onSelect(session.id)}
                      type="button"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate font-semibold" title={session.channelKey}>
                          {truncateMiddle(session.channelKey, 36)}
                        </span>
                        <span className="text-xs opacity-60">{session.messageCount}件</span>
                      </div>
                      <p className="mt-1 text-left text-xs opacity-60">
                        更新 {formatShortTimestamp(session.modified)}
                      </p>
                    </button>
                  );
                })}
              </div>
              <div className="flex justify-center pt-3">
                {sessionsNextCursor ? (
                  <button
                    className="btn btn-soft btn-primary btn-sm"
                    disabled={loadingMoreSessions}
                    onClick={onLoadMoreSessions}
                    type="button"
                  >
                    {loadingMoreSessions ? "読み込み中…" : "古いセッションを読み込む"}
                  </button>
                ) : (
                  <p className="text-xs opacity-60">これより古いセッションはありません</p>
                )}
              </div>
            </div>
          </div>
          <div className="md:col-span-2">
            <div className="flex flex-col gap-4">
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
        </div>
      )}
    </section>
  );
}
