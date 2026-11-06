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

const KIND_DOTS: Record<MemoryKind, string> = {
  fact: "bg-ink-faint",
  rule: "bg-brass",
  decision: "bg-sky",
  procedure: "bg-brass",
  temporary: "bg-ink-faint",
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

  return (
    <section className="flex flex-col gap-5" aria-labelledby="memory-heading">
      <ViewHeader
        count={`${scopes.length.toLocaleString("ja-JP")} スコープ`}
        description="Klein が会話から覚えているルールと事実。"
        headingId="memory-heading"
        title="メモリ"
      />

      {error && <ErrorNotice message={error} onRetry={onRetry} />}
      {!error && !enabled ? (
        <EmptyState>メモリ機能が無効です</EmptyState>
      ) : loading && scopes.length === 0 ? (
        <LoadingState />
      ) : scopes.length === 0 ? (
        <EmptyState>保存されたメモリがまだありません</EmptyState>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)] lg:items-start">
          <div className="lg:sticky lg:top-8">
            <label className="flex flex-col gap-1.5 lg:hidden">
              <span className="text-xs text-ink-faint">スコープ</span>
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
                  <option key={memoryScopeKey(summary.scope)} value={memoryScopeKey(summary.scope)}>
                    {scopeTypeLabel(summary.scope)} · {summary.entryCount} 件
                  </option>
                ))}
              </select>
            </label>

            <div className="hidden lg:block">
              <p className="px-1 pb-2 text-xs text-ink-faint">スコープ</p>
              <div
                aria-label="メモリスコープ一覧"
                className="max-h-[calc(100vh-14rem)] overflow-y-auto border-t border-rule"
              >
                {scopes.map((summary) => {
                  const selected =
                    selectedScope !== null &&
                    memoryScopeKey(selectedScope) === memoryScopeKey(summary.scope);
                  return (
                    <button
                      key={memoryScopeKey(summary.scope)}
                      aria-current={selected ? "true" : undefined}
                      className={`block w-full border-b border-rule border-l-2 py-3 pr-2 pl-3 text-left transition-colors ${
                        selected
                          ? "border-l-brass bg-night-900/70"
                          : "border-l-transparent hover:bg-night-850/60"
                      }`}
                      onClick={() => onSelect(summary.scope)}
                      type="button"
                    >
                      <span className="flex items-baseline justify-between gap-2">
                        <span
                          className={`text-[0.82rem] ${selected ? "text-brass-soft" : "text-ink"}`}
                        >
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
          </div>

          <div className="min-w-0">
            {deleteError && (
              <ErrorNotice
                message={deleteError}
                onRetry={onDismissDeleteError}
                retryLabel="閉じる"
              />
            )}
            {detailError && <ErrorNotice message={detailError} onRetry={onRetryDetail} />}
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
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-rule pb-4">
        <div className="min-w-0">
          <h2 className="text-[1.35rem] leading-snug text-ink">
            {scope.type === "owner" ? "オーナーのメモリ" : "ギルドのメモリ"}
          </h2>
          <p className="mt-1 truncate font-mono text-[0.66rem] text-ink-faint">
            {scope.type === "owner" ? "owner" : `guild ${scope.guildId}`}
          </p>
        </div>
        <p className="shrink-0 font-mono text-xs text-ink-faint">
          {entries.length.toLocaleString("ja-JP")} 件
        </p>
      </header>

      <details className="group border-b border-rule">
        <summary className="flex cursor-pointer list-none items-center justify-between py-3 text-sm text-ink-soft transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
          <span>ルールを追加</span>
          <span aria-hidden="true" className="font-mono text-base text-ink-faint">
            <span className="group-open:hidden">＋</span>
            <span className="hidden group-open:inline">−</span>
          </span>
        </summary>
        <form
          className="flex max-w-[44rem] flex-col gap-3 pb-5"
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
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-faint">タイトル</span>
            <input
              className="field"
              maxLength={200}
              onChange={(event) => setRuleTitle((event.target as HTMLInputElement).value)}
              required
              value={ruleTitle}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-faint">内容</span>
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
        <div className="divide-y divide-rule/60">
          {entries.map((entry) => (
            <article
              className="py-5 sm:grid sm:grid-cols-[6.5rem_minmax(0,1fr)] sm:gap-x-5"
              key={entry.id}
            >
              <div className="flex items-center gap-2 sm:flex-col sm:items-start sm:gap-1.5 sm:pt-1">
                <span
                  aria-hidden="true"
                  className={`size-1.5 rounded-full ${KIND_DOTS[entry.kind]}`}
                />
                <span className="font-mono text-[0.66rem] text-ink-faint">
                  {KIND_LABELS[entry.kind]}
                </span>
              </div>
              <div className="mt-2 min-w-0 max-w-[44rem] sm:mt-0">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h3 className="text-[1.05rem] leading-snug text-ink">{entry.title}</h3>
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
                <p className="mt-2 text-[0.83rem] leading-7 break-words whitespace-pre-wrap text-ink-soft">
                  {entry.content}
                </p>
                <footer className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[0.62rem] text-ink-faint">
                  <span>更新 {formatDate(entry.updatedAt)}</span>
                  <span>作成 {formatDate(entry.createdAt)}</span>
                  <span>参照 {entry.sourceMessageIds.length.toLocaleString("ja-JP")} 件</span>
                  {(entry.scope.type === "channel" || entry.scope.type === "thread") && (
                    <span title={entryScopeDetail(entry.scope)}>
                      {entryScopeDetail(entry.scope)}
                    </span>
                  )}
                </footer>
              </div>
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
