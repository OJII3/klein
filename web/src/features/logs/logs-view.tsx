import { useEffect, useState, type SubmitEvent } from "react";
import { Button, Select, TextInput } from "@mantine/core";

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

  useEffect(() => {
    setDraft(draftFromFilters(filters));
  }, [filters]);

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
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
        <div className="filter-field">
          <Select
            label="レベル"
            aria-label="ログレベル"
            data={LEVEL_OPTIONS}
            clearable
            placeholder="すべて"
            onChange={(level) => setDraft((current) => ({ ...current, level: level ?? "" }))}
            value={draft.level || null}
          />
        </div>
        <div className="filter-field filter-grow">
          <TextInput
            label="検索"
            aria-label="ログを検索"
            onChange={(event) => setDraft((current) => ({ ...current, q: event.target.value }))}
            placeholder="概要、イベント名…"
            value={draft.q}
          />
        </div>
        <div className="filter-field">
          <TextInput
            label="チャンネル"
            aria-label="チャンネルID"
            onChange={(event) =>
              setDraft((current) => ({ ...current, channelId: event.target.value }))
            }
            placeholder="channel ID"
            value={draft.channelId}
          />
        </div>
        <div className="filter-field">
          <TextInput
            label="イベント"
            aria-label="イベント名"
            onChange={(event) => setDraft((current) => ({ ...current, event: event.target.value }))}
            placeholder="event"
            value={draft.event}
          />
        </div>
        <div className="filter-actions">
          <Button color="teal" type="submit">
            絞り込む
          </Button>
          <Button variant="subtle" color="gray" onClick={clear} type="button">
            クリア
          </Button>
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
              <Button
                variant="light"
                color="teal"
                disabled={loadingMore}
                onClick={onLoadMore}
                type="button"
              >
                {loadingMore ? "読み込み中…" : "次のログを読み込む"}
              </Button>
            ) : (
              <span className="muted">これより古いログはありません</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
