import { useEffect, useState } from "preact/hooks";

import type { LogsQuery, PinoLog } from "../../api";
import { EmptyState, ErrorNotice, LoadingState } from "../../components/feedback";
import { Stat, StatStrip } from "../../components/stats";
import { ViewHeader } from "../../components/view-header";
import { LEVEL_OPTIONS, levelLabel } from "../../lib/format";
import { LogTable } from "./log-table";

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

interface LogFilterDraft {
  level: string;
  q: string;
  channelId: string;
  event: string;
}

const EMPTY_DRAFT: LogFilterDraft = { level: "", q: "", channelId: "", event: "" };

function draftFromFilters(filters: LogsQuery): LogFilterDraft {
  return {
    level: filters.level ?? "",
    q: filters.q ?? "",
    channelId: filters.channelId ?? "",
    event: filters.event ?? "",
  };
}

export function LogsView({
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
  const [draft, setDraft] = useState(() => draftFromFilters(filters));

  useEffect(() => setDraft(draftFromFilters(filters)), [filters]);

  const errorCount = logs.filter((log) => {
    const level = levelLabel(log.level);
    return level === "error" || level === "fatal";
  }).length;
  const warnCount = logs.filter((log) => levelLabel(log.level) === "warn").length;

  const submit = (event: SubmitEvent) => {
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
    setDraft(EMPTY_DRAFT);
    onFilter({ limit: 100 });
  };

  const update = (key: keyof LogFilterDraft) => (event: Event) => {
    const value = (event.target as HTMLInputElement | HTMLSelectElement).value;
    setDraft((current) => ({ ...current, [key]: value }));
  };

  return (
    <section className="flex flex-col gap-4" aria-labelledby="logs-heading">
      <ViewHeader headingId="logs-heading" title="アプリケーションログ">
        <StatStrip>
          <Stat label="表示中" value={logs.length.toLocaleString("ja-JP")} />
          <Stat label="エラー" tone={errorCount > 0 ? "text-red" : "text-ink"} value={errorCount} />
          <Stat label="警告" tone={warnCount > 0 ? "text-amber" : "text-ink"} value={warnCount} />
        </StatStrip>
      </ViewHeader>

      <form aria-label="ログの絞り込み" className="panel p-3" onSubmit={submit} role="search">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[9rem_minmax(0,1fr)_10rem_10rem_auto] xl:items-end">
          <label className="flex flex-col gap-1">
            <span className="text-[0.7rem] font-medium text-ink-soft">レベル</span>
            <select className="field" onChange={update("level")} value={draft.level}>
              <option value="">すべて</option>
              {LEVEL_OPTIONS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[0.7rem] font-medium text-ink-soft">検索</span>
            <input
              className="field"
              onChange={update("q")}
              placeholder="概要・イベント名で検索"
              type="search"
              value={draft.q}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[0.7rem] font-medium text-ink-soft">チャンネル</span>
            <input
              className="field"
              onChange={update("channelId")}
              placeholder="チャンネルID"
              value={draft.channelId}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[0.7rem] font-medium text-ink-soft">イベント</span>
            <input
              className="field"
              onChange={update("event")}
              placeholder="イベント名"
              value={draft.event}
            />
          </label>
          <div className="flex gap-2 sm:col-span-2 xl:col-span-1 xl:justify-end">
            <button className="btn btn-primary" type="submit">
              絞り込む
            </button>
            <button className="btn btn-ghost" onClick={clear} type="button">
              クリア
            </button>
          </div>
        </div>
      </form>

      {error && <ErrorNotice message={error} onRetry={onRetry} />}
      {loading && logs.length === 0 ? (
        <div className="panel">
          <LoadingState />
        </div>
      ) : logs.length === 0 ? (
        <div className="panel">
          <EmptyState>条件に一致するログはありません</EmptyState>
        </div>
      ) : (
        <div className="panel overflow-hidden">
          <LogTable
            expandedId={expandedId}
            logs={logs}
            onToggle={(id) => setExpandedId((current) => (current === id ? null : id))}
          />
          <div className="flex justify-center border-t border-line px-3 py-2.5">
            {nextCursor ? (
              <button
                className="btn btn-xs"
                disabled={loadingMore}
                onClick={onLoadMore}
                type="button"
              >
                {loadingMore ? "読み込み中…" : "次のログを読み込む"}
              </button>
            ) : (
              <p className="text-[0.7rem] text-ink-faint">これより古いログはありません</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
