import { useEffect, useState } from "preact/hooks";

import type { LogsQuery, PinoLog } from "../../api";
import { EmptyState, ErrorNotice, LoadingState } from "../../components/feedback";
import { LEVEL_OPTIONS } from "../../lib/format";
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
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-wider text-primary">PINO / JSONL</p>
          <h2 className="text-2xl font-bold" id="logs-heading">
            アプリケーションログ
          </h2>
        </div>
        <p className="text-sm opacity-70">{logs.length.toLocaleString("ja-JP")} 件</p>
      </div>

      <form className="rounded-box border border-base-300 bg-base-200 p-4" onSubmit={submit}>
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-12">
          <label className="flex flex-col gap-1 sm:col-span-3">
            <span className="text-xs opacity-70">レベル</span>
            <select
              aria-label="ログレベル"
              className="select select-sm w-full"
              onChange={update("level")}
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
          <label className="flex flex-col gap-1 sm:col-span-3">
            <span className="text-xs opacity-70">検索</span>
            <input
              aria-label="ログを検索"
              className="input input-sm w-full"
              onChange={update("q")}
              placeholder="概要、イベント名…"
              value={draft.q}
            />
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="text-xs opacity-70">チャンネル</span>
            <input
              aria-label="チャンネルID"
              className="input input-sm w-full"
              onChange={update("channelId")}
              placeholder="channel ID"
              value={draft.channelId}
            />
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="text-xs opacity-70">イベント</span>
            <input
              aria-label="イベント名"
              className="input input-sm w-full"
              onChange={update("event")}
              placeholder="event"
              value={draft.event}
            />
          </label>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <button className="btn btn-primary btn-sm" type="submit">
              絞り込む
            </button>
            <button className="btn btn-ghost btn-sm" onClick={clear} type="button">
              クリア
            </button>
          </div>
        </div>
      </form>

      {error && <ErrorNotice message={error} onRetry={onRetry} />}
      {loading && logs.length === 0 ? (
        <LoadingState />
      ) : logs.length === 0 ? (
        <EmptyState>条件に一致するログはありません</EmptyState>
      ) : (
        <div className="rounded-box border border-base-300 bg-base-200">
          <LogTable
            expandedId={expandedId}
            logs={logs}
            onToggle={(id) => setExpandedId((current) => (current === id ? null : id))}
          />
          <div className="flex justify-center p-4">
            {nextCursor ? (
              <button
                className="btn btn-soft btn-primary btn-sm"
                disabled={loadingMore}
                onClick={onLoadMore}
                type="button"
              >
                {loadingMore ? "読み込み中…" : "次のログを読み込む"}
              </button>
            ) : (
              <p className="text-sm opacity-70">これより古いログはありません</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
