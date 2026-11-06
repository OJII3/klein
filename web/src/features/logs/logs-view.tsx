import { useEffect, useState } from "preact/hooks";

import type { LogsQuery, PinoLog } from "../../api";
import { EmptyState, ErrorNotice, LoadingState } from "../../components/feedback";
import { ViewHeader } from "../../components/view-header";
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
    <section className="flex flex-col gap-5" aria-labelledby="logs-heading">
      <ViewHeader
        count={`${logs.length.toLocaleString("ja-JP")} 件`}
        description="Klein が実行したことの連続記録。新しいものが上に並びます。"
        headingId="logs-heading"
        title="アプリケーションログ"
      />

      <form
        aria-label="ログの絞り込み"
        className="grid gap-2 border-b border-rule pb-4 sm:grid-cols-2 lg:grid-cols-[9rem_minmax(0,1fr)_10rem_10rem_auto]"
        onSubmit={submit}
        role="search"
      >
        <select
          aria-label="ログレベル"
          className="field"
          onChange={update("level")}
          value={draft.level}
        >
          <option value="">すべてのレベル</option>
          {LEVEL_OPTIONS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
        <input
          aria-label="ログを検索"
          className="field"
          onChange={update("q")}
          placeholder="概要やイベント名を検索"
          type="search"
          value={draft.q}
        />
        <input
          aria-label="チャンネルID"
          className="field"
          onChange={update("channelId")}
          placeholder="チャンネルID"
          value={draft.channelId}
        />
        <input
          aria-label="イベント名"
          className="field"
          onChange={update("event")}
          placeholder="イベント名"
          value={draft.event}
        />
        <div className="flex gap-2 sm:col-span-2 lg:col-span-1">
          <button className="btn btn-primary" type="submit">
            絞り込む
          </button>
          <button className="btn btn-quiet" onClick={clear} type="button">
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
        <div className="flex flex-col gap-5">
          <LogTable
            expandedId={expandedId}
            logs={logs}
            onToggle={(id) => setExpandedId((current) => (current === id ? null : id))}
          />
          <div className="flex justify-center">
            {nextCursor ? (
              <button className="btn" disabled={loadingMore} onClick={onLoadMore} type="button">
                {loadingMore ? "読み込み中…" : "次のログを読み込む"}
              </button>
            ) : (
              <p className="font-mono text-[0.7rem] text-ink-faint">これより古いログはありません</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
