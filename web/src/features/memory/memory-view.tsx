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
  channelNames: ReadonlyMap<string, string>;
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
  fact: "badge-ghost",
  rule: "badge-success badge-soft",
  decision: "badge-info badge-soft",
  procedure: "badge-success badge-soft",
  temporary: "badge-warning badge-soft",
};

export function MemoryView(props: MemoryViewProps) {
  const {
    channelNames,
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
        <div className="card border border-base-300 bg-base-100">
          <EmptyState>メモリ機能が無効です</EmptyState>
        </div>
      ) : loading && scopes.length === 0 ? (
        <div className="card border border-base-300 bg-base-100">
          <LoadingState />
        </div>
      ) : scopes.length === 0 ? (
        <div className="card border border-base-300 bg-base-100">
          <EmptyState>保存されたメモリがまだありません</EmptyState>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)] lg:items-start">
          <div className="card overflow-hidden border border-base-300 bg-base-100 lg:sticky lg:top-[4.25rem]">
            <div className="border-b border-line p-3 lg:hidden">
              <label className="flex flex-col gap-1">
                <span className="text-[0.7rem] font-medium text-ink-soft">スコープ</span>
                <select
                  className="select select-sm w-full"
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

            <div className="hidden lg:block">
              <ul className="menu menu-sm w-full flex-nowrap p-0 [--menu-active-bg:var(--color-green-soft)] [--menu-active-fg:var(--color-green-strong)]">
                {scopes.map((summary) => {
                  const selected =
                    selectedScope !== null &&
                    memoryScopeKey(selectedScope) === memoryScopeKey(summary.scope);
                  return (
                    <li key={memoryScopeKey(summary.scope)}>
                      <button
                        aria-current={selected ? "true" : undefined}
                        className="w-full"
                        onClick={() => onSelect(summary.scope)}
                        type="button"
                      >
                        <span className="flex w-full min-w-0 flex-col items-stretch gap-0.5">
                          <span className="flex items-baseline justify-between gap-2">
                            <span className="text-[0.8rem] font-medium text-ink">
                              {scopeTypeLabel(summary.scope)}
                            </span>
                            <span className="font-mono text-[0.62rem] text-ink-faint">
                              {summary.entryCount} 件
                            </span>
                          </span>
                          {summary.scope.type === "guild" && (
                            <span className="truncate font-mono text-[0.62rem] text-ink-faint">
                              {summary.scope.guildId}
                            </span>
                          )}
                          <span className="font-mono text-[0.62rem] text-ink-faint">
                            更新 {formatCompactTimestamp(summary.updatedAt ?? undefined)}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
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
            <div className="card overflow-hidden border border-base-300 bg-base-100">
              {loadingDetail ? (
                <LoadingState label="メモリを読み込み中…" />
              ) : selectedScope ? (
                <MemoryEntries
                  addingRule={addingRule}
                  addRuleError={addRuleError}
                  channelNames={channelNames}
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
  channelNames,
  deletingEntryId,
  entries,
  scope,
  onDelete,
  addingRule,
  addRuleError,
  onAddRule,
}: {
  channelNames: ReadonlyMap<string, string>;
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

      <details className="collapse collapse-arrow border-b border-base-300">
        <summary className="collapse-title text-sm text-ink-soft">ルールを追加</summary>
        <form
          className="collapse-content flex max-w-2xl flex-col gap-3 px-4"
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
              className="input input-sm w-full"
              maxLength={200}
              onChange={(event) => setRuleTitle((event.target as HTMLInputElement).value)}
              required
              value={ruleTitle}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[0.7rem] font-medium text-ink-soft">内容</span>
            <textarea
              className="textarea textarea-sm min-h-[5.5rem] w-full resize-y"
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
            className="btn btn-primary btn-sm w-fit"
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
                  <span className={`badge badge-sm font-medium ${KIND_TONES[entry.kind]}`}>
                    {KIND_LABELS[entry.kind]}
                  </span>
                  <h3 className="text-[0.9rem] font-semibold text-ink">{entry.title}</h3>
                </div>
                <button
                  className="btn btn-error btn-soft btn-xs"
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
                  <span title={entryScopeDetail(entry.scope, channelNames)}>
                    {entryScopeDetail(entry.scope, channelNames)}
                  </span>
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

function entryScopeDetail(
  scope: MemoryEntryScope,
  channelNames: ReadonlyMap<string, string>,
): string {
  const label = (channelId: string): string => channelNames.get(channelId) ?? channelId;
  if (scope.type === "channel") return `チャンネル: ${label(scope.channelId)}`;
  if (scope.type === "thread")
    return `スレッド: ${label(scope.threadId)} (チャンネル: ${label(scope.channelId)})`;
  return scope.type === "owner" ? "オーナー" : "ギルド全体";
}
