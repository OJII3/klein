import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { flexRender } from "@tanstack/react-table";
import {
  getCoreRowModel,
  useLegacyTable,
  type LegacyColumnDef,
} from "@tanstack/react-table/legacy";

import {
  getSession,
  listLogs,
  listSessions,
  type LogsQuery,
  type PiSessionEvent,
  type PinoLog,
  type SessionSummary,
} from "./api.js";

type View = "logs" | "sessions";

const LEVEL_LABELS: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

const LEVEL_OPTIONS = ["trace", "debug", "info", "warn", "error", "fatal"];

function formatTimestamp(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ja-JP", {
    dateStyle: "short",
    timeStyle: "medium",
  });
}

function levelLabel(level: number | string): string {
  if (typeof level === "number") return LEVEL_LABELS[level] ?? String(level);
  return level;
}

function levelClass(level: number | string): string {
  const label = levelLabel(level);
  return `level-${label.toLowerCase()}`;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "—";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="notice notice-error" role="alert">
      <span>{message}</span>
      <button className="button button-small" onClick={onRetry} type="button">
        再試行
      </button>
    </div>
  );
}

function EmptyState({ children }: { children: string }) {
  return <div className="empty-state">{children}</div>;
}

function LoadingState({ label = "読み込み中…" }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

interface LogTableProps {
  logs: PinoLog[];
  expandedId: string | null;
  onToggle: (id: string) => void;
}

function LogTable({ logs, expandedId, onToggle }: LogTableProps) {
  const columns = useMemo<LegacyColumnDef<PinoLog>[]>(
    () => [
      {
        accessorKey: "timestamp",
        header: "時刻",
        cell: ({ getValue }) => (
          <time dateTime={String(getValue())}>{formatTimestamp(String(getValue()))}</time>
        ),
      },
      {
        accessorKey: "level",
        header: "レベル",
        cell: ({ getValue }) => {
          const level = getValue() as number | string;
          return <span className={`level-badge ${levelClass(level)}`}>{levelLabel(level)}</span>;
        },
      },
      {
        accessorKey: "kind",
        header: "イベント",
        cell: ({ getValue }) => <code className="event-name">{String(getValue())}</code>,
      },
      {
        accessorKey: "summary",
        header: "概要",
        cell: ({ getValue }) => <span className="summary-cell">{String(getValue() ?? "")}</span>,
      },
    ],
    [],
  );

  const table = useLegacyTable({
    data: logs,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <>
      <div className="desktop-table-wrap">
        <table className="log-table">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th key={header.id} scope="col">
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => {
              const log = row.original;
              const isExpanded = expandedId === log.id;
              return (
                <Fragment key={row.id}>
                  <tr
                    className={`log-row${isExpanded ? " is-expanded" : ""}`}
                    key={row.id}
                    onClick={() => onToggle(log.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") onToggle(log.id);
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                  {isExpanded && (
                    <tr className="log-detail-row" key={`${row.id}-detail`}>
                      <td colSpan={columns.length}>
                        <LogDetails log={log} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mobile-log-list">
        {logs.map((log) => {
          const isExpanded = expandedId === log.id;
          return (
            <article className={`log-card${isExpanded ? " is-expanded" : ""}`} key={log.id}>
              <button className="log-card-trigger" onClick={() => onToggle(log.id)} type="button">
                <span className="log-card-meta">
                  <time dateTime={log.timestamp}>{formatTimestamp(log.timestamp)}</time>
                  <span className={`level-badge ${levelClass(log.level)}`}>
                    {levelLabel(log.level)}
                  </span>
                </span>
                <code className="event-name">{log.kind}</code>
                <span className="log-card-summary">{log.summary}</span>
              </button>
              {isExpanded && <LogDetails log={log} />}
            </article>
          );
        })}
      </div>
    </>
  );
}

function LogDetails({ log }: { log: PinoLog }) {
  const attributes = Object.keys(log.attributes ?? {}).length > 0 ? log.attributes : null;
  return (
    <div className="log-details">
      <dl className="detail-grid">
        <div>
          <dt>ID</dt>
          <dd className="mono">{log.id}</dd>
        </div>
        <div>
          <dt>レベル</dt>
          <dd>{levelLabel(log.level)}</dd>
        </div>
      </dl>
      {attributes ? (
        <pre className="json-block">{stringify(attributes)}</pre>
      ) : (
        <p className="muted">属性はありません</p>
      )}
    </div>
  );
}

interface LogsViewProps {
  logs: PinoLog[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  nextCursor: string | null;
  filters: LogsQuery;
  onFilter: (query: LogsQuery) => void;
  onRetry: () => void;
  onLoadMore: () => void;
}

function LogsView({
  logs,
  loading,
  loadingMore,
  error,
  nextCursor,
  filters,
  onFilter,
  onRetry,
  onLoadMore,
}: LogsViewProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    level: filters.level ?? "",
    q: filters.q ?? "",
    channelId: filters.channelId ?? "",
    event: filters.event ?? "",
  });

  useEffect(() => {
    setDraft({
      level: filters.level ?? "",
      q: filters.q ?? "",
      channelId: filters.channelId ?? "",
      event: filters.event ?? "",
    });
  }, [filters]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onFilter({
      limit: 100,
      ...(draft.level ? { level: draft.level } : {}),
      ...(draft.q ? { q: draft.q } : {}),
      ...(draft.channelId ? { channelId: draft.channelId } : {}),
      ...(draft.event ? { event: draft.event } : {}),
    });
  };

  const clear = () => {
    setDraft({ level: "", q: "", channelId: "", event: "" });
    onFilter({ limit: 100 });
  };

  return (
    <section className="view-section" aria-labelledby="logs-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">PINO / JSONL</p>
          <h2 id="logs-heading">アプリケーションログ</h2>
        </div>
        <span className="result-count">{logs.length.toLocaleString("ja-JP")} 件</span>
      </div>

      <form className="filter-bar" onSubmit={submit}>
        <label>
          <span>レベル</span>
          <select
            aria-label="ログレベル"
            onChange={(event) => setDraft((current) => ({ ...current, level: event.target.value }))}
            value={draft.level}
          >
            <option value="">すべて</option>
            {LEVEL_OPTIONS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-grow">
          <span>検索</span>
          <input
            aria-label="ログを検索"
            onChange={(event) => setDraft((current) => ({ ...current, q: event.target.value }))}
            placeholder="概要、イベント名…"
            type="search"
            value={draft.q}
          />
        </label>
        <label>
          <span>チャンネル</span>
          <input
            aria-label="チャンネルID"
            onChange={(event) =>
              setDraft((current) => ({ ...current, channelId: event.target.value }))
            }
            placeholder="channel ID"
            value={draft.channelId}
          />
        </label>
        <label>
          <span>イベント</span>
          <input
            aria-label="イベント名"
            onChange={(event) => setDraft((current) => ({ ...current, event: event.target.value }))}
            placeholder="event"
            value={draft.event}
          />
        </label>
        <div className="filter-actions">
          <button className="button button-primary" type="submit">
            絞り込む
          </button>
          <button className="button button-quiet" onClick={clear} type="button">
            クリア
          </button>
        </div>
      </form>

      {error && <ErrorNotice message={error} onRetry={onRetry} />}
      {loading && logs.length === 0 ? (
        <LoadingState />
      ) : logs.length === 0 ? (
        <EmptyState>条件に一致するログはありません</EmptyState>
      ) : (
        <div className="data-panel">
          <LogTable
            expandedId={expandedId}
            logs={logs}
            onToggle={(id) => setExpandedId((current) => (current === id ? null : id))}
          />
          <div className="pagination-row">
            {nextCursor ? (
              <button className="button" disabled={loadingMore} onClick={onLoadMore} type="button">
                {loadingMore ? "読み込み中…" : "次のログを読み込む"}
              </button>
            ) : (
              <span className="muted">これより古いログはありません</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

interface SessionsViewProps {
  sessions: SessionSummary[];
  selectedSession: SessionSummary | null;
  events: PiSessionEvent[];
  loading: boolean;
  loadingDetail: boolean;
  error: string | null;
  detailError: string | null;
  onSelect: (id: string) => void;
  onRetry: () => void;
  onRetryDetail: () => void;
}

function SessionsView({
  sessions,
  selectedSession,
  events,
  loading,
  loadingDetail,
  error,
  detailError,
  onSelect,
  onRetry,
  onRetryDetail,
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
          </div>

          <div className="session-detail">
            {detailError && <ErrorNotice message={detailError} onRetry={onRetryDetail} />}
            {loadingDetail ? (
              <LoadingState label="セッションを読み込み中…" />
            ) : selectedSession ? (
              <SessionTimeline events={events} session={selectedSession} />
            ) : (
              <EmptyState>セッションを選択してください</EmptyState>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function SessionTimeline({
  events,
  session,
}: {
  events: PiSessionEvent[];
  session: SessionSummary;
}) {
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
                  <pre className="timeline-content">{stringify(event.content)}</pre>
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

export default function App() {
  const [view, setView] = useState<View>("logs");
  const [logs, setLogs] = useState<PinoLog[]>([]);
  const [logFilters, setLogFilters] = useState<LogsQuery>({ limit: 100 });
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsLoadingMore, setLogsLoadingMore] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<SessionSummary | null>(null);
  const [sessionEvents, setSessionEvents] = useState<PiSessionEvent[]>([]);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const loadLogs = useCallback(async (query: LogsQuery, append = false) => {
    if (append) setLogsLoadingMore(true);
    else setLogsLoading(true);
    setLogsError(null);
    try {
      const response = await listLogs(query);
      setLogs((current) => (append ? [...current, ...response.items] : response.items));
      setNextCursor(response.nextCursor);
      setLastUpdated(new Date());
    } catch (error) {
      setLogsError(error instanceof Error ? error.message : "ログの取得に失敗しました");
    } finally {
      if (append) setLogsLoadingMore(false);
      else setLogsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view !== "logs") return;
    void loadLogs(logFilters);
    const timer = window.setInterval(() => void loadLogs(logFilters), 5000);
    return () => window.clearInterval(timer);
  }, [loadLogs, logFilters, view]);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      const response = await listSessions();
      setSessions(response.items);
      setSelectedSessionId((current) => current ?? response.items[0]?.id ?? null);
      setLastUpdated(new Date());
    } catch (error) {
      setSessionsError(error instanceof Error ? error.message : "セッションの取得に失敗しました");
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view !== "sessions") return;
    void loadSessions();
    const timer = window.setInterval(() => void loadSessions(), 10000);
    return () => window.clearInterval(timer);
  }, [loadSessions, view]);

  useEffect(() => {
    if (!selectedSessionId || view !== "sessions") return;
    let active = true;
    setSessionLoading(true);
    setSessionError(null);
    void getSession(selectedSessionId)
      .then((response) => {
        if (!active) return;
        setSelectedSession(response.session);
        setSessionEvents(response.items);
      })
      .catch((error: unknown) => {
        if (active)
          setSessionError(
            error instanceof Error ? error.message : "セッションの取得に失敗しました",
          );
      })
      .finally(() => {
        if (active) setSessionLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedSessionId, view]);

  const selectedFromList = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? selectedSession,
    [selectedSession, selectedSessionId, sessions],
  );

  const refreshCurrentView = () => {
    if (view === "logs") void loadLogs(logFilters);
    else void loadSessions();
  };

  const loadMoreLogs = () => {
    if (nextCursor) void loadLogs({ ...logFilters, cursor: nextCursor }, true);
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            ◒
          </span>
          <div>
            <p className="eyebrow">KLEIN OBSERVATORY</p>
            <h1>ログとセッション</h1>
          </div>
        </div>
        <div className="header-status">
          <span className="status-dot" aria-hidden="true" />
          <span>ローカル接続</span>
          {lastUpdated && (
            <time dateTime={lastUpdated.toISOString()}>
              更新 {formatTimestamp(lastUpdated.toISOString())}
            </time>
          )}
          <button
            aria-label="再読み込み"
            className="icon-button"
            onClick={refreshCurrentView}
            type="button"
          >
            ↻
          </button>
        </div>
      </header>

      <nav className="view-tabs" aria-label="表示切り替え">
        <button
          className={view === "logs" ? "is-active" : ""}
          onClick={() => setView("logs")}
          type="button"
        >
          <span aria-hidden="true">▤</span> ログ
        </button>
        <button
          className={view === "sessions" ? "is-active" : ""}
          onClick={() => setView("sessions")}
          type="button"
        >
          <span aria-hidden="true">◌</span> Piセッション
        </button>
      </nav>

      <main>
        {view === "logs" ? (
          <LogsView
            error={logsError}
            filters={logFilters}
            loading={logsLoading}
            loadingMore={logsLoadingMore}
            logs={logs}
            nextCursor={nextCursor}
            onFilter={(query) => setLogFilters(query)}
            onLoadMore={loadMoreLogs}
            onRetry={refreshCurrentView}
          />
        ) : (
          <SessionsView
            detailError={sessionError}
            error={sessionsError}
            events={sessionEvents}
            loading={sessionsLoading}
            loadingDetail={sessionLoading}
            onRetry={refreshCurrentView}
            onRetryDetail={() => {
              if (selectedSessionId) {
                setSelectedSessionId(null);
                window.setTimeout(() => setSelectedSessionId(selectedSessionId), 0);
              }
            }}
            onSelect={setSelectedSessionId}
            selectedSession={selectedFromList ?? null}
            sessions={sessions}
          />
        )}
      </main>

      <footer className="app-footer">Klein / read-only viewer</footer>
    </div>
  );
}
