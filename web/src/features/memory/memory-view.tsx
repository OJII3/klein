import { useState } from "preact/hooks";

import {
  memoryScopeKey,
  type MemoryEntry,
  type MemoryEntryScope,
  type MemoryKind,
  type MemoryScope,
  type MemoryScopeSummary,
} from "../../api";
import { EmptyState, ErrorNotice, LoadingState } from "../../components/feedback";
import { Stat, StatStrip } from "../../components/stats";
import { ViewHeader } from "../../components/view-header";
import { formatCompactTimestamp, formatDate } from "../../lib/format";

interface MemoryViewProps {
  enabled: boolean;
  scopes: MemoryScopeSummary[];
  selectedScope: MemoryScope | null;
  entries: MemoryEntry[];
  loading: boolean;
  loadingDetail: boolean;
  error: string | null;
  detailError: string | null;
  deleteError: string | null;
  deletingEntryId: string | null;
  addingRule: boolean;
  addRuleError: string | null;
  onSelect: (scope: MemoryScope) => void;
  onDelete: (entryId: string) => void;
  onAddRule: (title: string, content: string) => void;
  onDismissDeleteError: () => void;
  onRetry: () => void;
  onRetryDetail: () => void;
}

const KIND_LABELS: Record<MemoryKind, string> = {
  fact: "事実",
  rule: "ルール",
  decision: "決定",
  procedure: "手順",
  temporary: "一時",
};

const KIND_TONES: Record<MemoryKind, string> = {
  fact: "bg-surface-muted text-ink-soft",
  rule: "bg-green-soft text-green-strong",
  decision: "bg-blue-soft text-blue",
  procedure: "bg-green-soft text-green-strong",
  temporary: "bg-amber-soft text-amber",
};

export function MemoryView(props: MemoryViewProps) {
  const {
    enabled,
    scopes,
    selectedScope,
    entries,
    loading,
    loadingDetail,
    error,
    detailError,
    deleteError,
    deletingEntryId,
    addingRule,
    addRuleError,
    onSelect,
    onDelete,
    onAddRule,
    onDismissDeleteError,
    onRetry,
    onRetryDetail,
  } = props;
  const totalEntries = scopes.reduce((sum, summary) => sum + summary.entryCount, 0);

  return (
    <section className="flex flex-col gap-4" aria-labelledby="memory-heading">
      <ViewHeader headingId="memory-heading" title="メモリ">
        <StatStrip>
          <Stat label="スコープ" value={scopes.length.toLocaleString("ja-JP")} />
          <Stat label="エントリ" value={totalEntries.toLocaleString("ja-JP")} />
        </StatStrip>
      </ViewHeader>

      {error && <ErrorNotice message={error} onRetry={onRetry} />}
      {!error && !enabled ? (
        <div className="panel">
          <EmptyState>メモリ機能が無効です</EmptyState>
        </div>
      ) : loading && scopes.length === 0 ? (
        <div className="panel">
          <LoadingState />
        </div>
      ) : scopes.length === 0 ? (
        <div className="panel">
          <EmptyState>保存されたメモリがまだありません</EmptyState>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)] lg:items-start">
          <div className="panel overflow-hidden lg:sticky lg:top-[4.25rem]">
            <div className="border-b border-line p-3 lg:hidden">
              <label className="flex flex-col gap-1">
                <span className="text-[0.7rem] font-medium text-ink-soft">スコープ</span>
                <select
                  className="field"
                  onChange={(event) => {
                    const key = (event.target as HTMLSelectElement).value;
                    const summary = scopes.find((item) => memoryScopeKey(item.scope) === key);
                    if (summary) onSelect(summary.scope);
                  }}
                  value={selectedScope ? memoryScopeKey(selectedScope) : ""}
                >
                  <option disabled value="">
                    スコープを選択
                  </option>
                  {scopes.map((summary) => (
                    <option
                      key={memoryScopeKey(summary.scope)}
                      value={memoryScopeKey(summary.scope)}
                    >
                      {scopeTypeLabel(summary.scope)}（{summary.entryCount} 件）
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="hidden items-center justify-between border-b border-line px-3 py-2 lg:flex">
              <span className="text-[0.7rem] font-medium text-ink-faint">スコープ</span>
              <span className="font-mono text-[0.62rem] text-ink-faint">{scopes.length} 件</span>
            </div>

            <div className="hidden divide-y divide-line lg:block">
              {scopes.map((summary) => {
                const selected =
                  selectedScope !== null &&
                  memoryScopeKey(selectedScope) === memoryScopeKey(summary.scope);
                return (
                  <button
                    key={memoryScopeKey(summary.scope)}
                    aria-current={selected ? "true" : undefined}
                    className={`block w-full border-l-2 px-3 py-2.5 text-left transition-colors ${
                      selected
                        ? "border-l-green bg-green-soft/60"
                        : "border-l-transparent hover:bg-surface-muted"
                    }`}
                    onClick={() => onSelect(summary.scope)}
                    type="button"
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-[0.8rem] font-medium text-ink">
                        {scopeTypeLabel(summary.scope)}
                      </span>
                      <span className="font-mono text-[0.62rem] text-ink-faint">
                        {summary.entryCount} 件
                      </span>
                    </span>
                    {summary.scope.type === "guild" && (
                      <span className="mt-0.5 block truncate font-mono text-[0.62rem] text-ink-faint">
                        {summary.scope.guildId}
                      </span>
                    )}
                    <span className="mt-1 block font-mono text-[0.62rem] text-ink-faint">
                      更新 {formatCompactTimestamp(summary.updatedAt ?? undefined)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-3">
            {deleteError && (
              <ErrorNotice
                message={deleteError}
                onRetry={onDismissDeleteError}
                retryLabel="閉じる"
              />
            )}
            {detailError && <ErrorNotice message={detailError} onRetry={onRetryDetail} />}
            <div className="panel overflow-hidden">
              {loadingDetail ? (
                <LoadingState label="メモリを読み込み中…" />
              ) : selectedScope ? (
                <MemoryEntries
                  addingRule={addingRule}
                  addRuleError={addRuleError}
                  deletingEntryId={deletingEntryId}
                  entries={entries}
                  onAddRule={onAddRule}
                  onDelete={onDelete}
                  scope={selectedScope}
                />
              ) : (
                <EmptyState>スコープを選択してください</EmptyState>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function MemoryEntries({
  deletingEntryId,
  entries,
  scope,
  onDelete,
  addingRule,
  addRuleError,
  onAddRule,
}: {
  deletingEntryId: string | null;
  entries: MemoryEntry[];
  scope: MemoryScope;
  onDelete: (entryId: string) => void;
  addingRule: boolean;
  addRuleError: string | null;
  onAddRule: (title: string, content: string) => void;
}) {
  const [ruleTitle, setRuleTitle] = useState("");
  const [ruleContent, setRuleContent] = useState("");

  return (
    <div className="flex min-w-0 flex-col">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-4">
        <div className="min-w-0">
          <h2 className="text-[1.05rem] font-semibold text-ink">
            {scope.type === "owner" ? "オーナーのメモリ" : "ギルドのメモリ"}
          </h2>
          <p className="mt-1 truncate font-mono text-[0.64rem] text-ink-faint">
            {scope.type === "owner" ? "owner" : `guild ${scope.guildId}`}
          </p>
        </div>
        <p className="shrink-0 font-mono text-[0.68rem] text-ink-faint">
          {entries.length.toLocaleString("ja-JP")} 件
        </p>
      </header>

      <details className="group border-b border-line">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm text-ink-soft transition-colors hover:bg-surface-muted [&::-webkit-details-marker]:hidden">
          <span>ルールを追加</span>
          <span aria-hidden="true" className="font-mono text-base text-ink-faint">
            <span className="group-open:hidden">＋</span>
            <span className="hidden group-open:inline">−</span>
          </span>
        </summary>
        <form
          className="flex max-w-2xl flex-col gap-3 border-t border-line bg-surface-muted/60 px-4 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            const title = ruleTitle.trim();
            const content = ruleContent.trim();
            if (!title || !content) return;
            onAddRule(title, content);
            setRuleTitle("");
            setRuleContent("");
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="text-[0.7rem] font-medium text-ink-soft">タイトル</span>
            <input
              className="field"
              maxLength={200}
              onChange={(event) => setRuleTitle((event.target as HTMLInputElement).value)}
              required
              value={ruleTitle}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[0.7rem] font-medium text-ink-soft">内容</span>
            <textarea
              className="field min-h-[5.5rem] resize-y"
              maxLength={10000}
              onChange={(event) => setRuleContent((event.target as HTMLTextAreaElement).value)}
              required
              rows={3}
              value={ruleContent}
            />
          </label>
          {addRuleError && (
            <ErrorNotice
              message={addRuleError}
              onRetry={() => onAddRule(ruleTitle.trim(), ruleContent.trim())}
            />
          )}
          <button
            className="btn btn-primary w-fit"
            disabled={addingRule || !ruleTitle.trim() || !ruleContent.trim()}
            type="submit"
          >
            {addingRule ? "追加中…" : "ルールを追加"}
          </button>
        </form>
      </details>

      {entries.length === 0 ? (
        <EmptyState>このスコープのメモリは空です</EmptyState>
      ) : (
        <div className="divide-y divide-line">
          {entries.map((entry) => (
            <article className="px-4 py-4" key={entry.id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[0.62rem] font-medium ${KIND_TONES[entry.kind]}`}
                  >
                    {KIND_LABELS[entry.kind]}
                  </span>
                  <h3 className="text-[0.9rem] font-semibold text-ink">{entry.title}</h3>
                </div>
                <button
                  className="btn btn-danger btn-xs"
                  disabled={deletingEntryId !== null}
                  onClick={() => {
                    if (
                      window.confirm(
                        `「${entry.title}」を削除しますか？\nこの操作は元に戻せません。`,
                      )
                    )
                      onDelete(entry.id);
                  }}
                  type="button"
                >
                  {deletingEntryId === entry.id ? "削除中…" : "削除"}
                </button>
              </div>
              <p className="mt-2 max-w-[60rem] text-[0.82rem] leading-6 break-words whitespace-pre-wrap text-ink-soft">
                {entry.content}
              </p>
              <footer className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[0.62rem] text-ink-faint">
                <span>更新 {formatDate(entry.updatedAt)}</span>
                <span>作成 {formatDate(entry.createdAt)}</span>
                <span>参照 {entry.sourceMessageIds.length.toLocaleString("ja-JP")} 件</span>
                {(entry.scope.type === "channel" || entry.scope.type === "thread") && (
                  <span title={entryScopeDetail(entry.scope)}>{entryScopeDetail(entry.scope)}</span>
                )}
              </footer>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function scopeTypeLabel(scope: MemoryScope): string {
  return scope.type === "owner" ? "オーナー" : "ギルド";
}

function entryScopeDetail(scope: MemoryEntryScope): string {
  if (scope.type === "channel") return `チャンネル: ${scope.channelId}`;
  if (scope.type === "thread")
    return `スレッド: ${scope.threadId} (チャンネル: ${scope.channelId})`;
  return scope.type === "owner" ? "オーナー" : "ギルド全体";
}
