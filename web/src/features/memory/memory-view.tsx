import { useState } from "preact/hooks";

import {
  memoryScopeKey,
  type MemoryEntry,
  type MemoryEntryScope,
  type MemoryScope,
  type MemoryScopeSummary,
} from "../../api";
import { EmptyState, ErrorNotice, LoadingState } from "../../components/feedback";
import { formatTimestamp } from "../../lib/format";

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
    <section className="flex flex-col gap-4" aria-labelledby="memory-heading">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-wider text-primary">PERSISTED MEMORY CONTEXT</p>
          <h2 className="text-2xl font-bold" id="memory-heading">
            メモリ
          </h2>
        </div>
        <p className="text-sm opacity-70">{scopes.length.toLocaleString("ja-JP")} スコープ</p>
      </div>
      {error && <ErrorNotice message={error} onRetry={onRetry} />}
      {!error && !enabled ? (
        <EmptyState>メモリ機能が無効です</EmptyState>
      ) : loading && scopes.length === 0 ? (
        <LoadingState />
      ) : scopes.length === 0 ? (
        <EmptyState>保存されたメモリがまだありません</EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="md:col-span-1">
            <label className="flex flex-col gap-1 md:hidden">
              <span className="text-xs opacity-70">スコープ</span>
              <select
                className="select w-full"
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
                    {scopeName(summary.scope)} · {summary.entryCount} 件
                  </option>
                ))}
              </select>
            </label>
            <div className="hidden rounded-box border border-base-300 bg-base-200 p-2 md:block">
              <div
                aria-label="メモリスコープ一覧"
                className="flex max-h-[360px] flex-col gap-2 overflow-auto"
              >
                {scopes.map((summary) => {
                  const selected =
                    selectedScope !== null &&
                    memoryScopeKey(selectedScope) === memoryScopeKey(summary.scope);
                  return (
                    <button
                      key={memoryScopeKey(summary.scope)}
                      className={`w-full rounded-box border p-3 text-left transition ${
                        selected
                          ? "border-primary bg-primary/15"
                          : "border-base-300 bg-base-100 hover:bg-base-300/50"
                      }`}
                      onClick={() => onSelect(summary.scope)}
                      type="button"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="badge badge-sm badge-soft">
                          {summary.scope.type === "owner" ? "OWNER" : "GUILD"}
                        </span>
                        <span className="text-xs opacity-60">{summary.entryCount} 件</span>
                      </div>
                      <code className="mt-2 block truncate rounded bg-base-300 px-1.5 py-0.5 font-mono text-xs">
                        {scopeName(summary.scope)}
                      </code>
                      <p className="mt-1 text-left text-xs opacity-60">
                        更新 {formatTimestamp(summary.updatedAt ?? undefined)}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="md:col-span-2">
            <div className="flex flex-col gap-4">
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
    <div className="flex flex-col gap-4">
      <div className="rounded-box border border-base-300 bg-base-200 p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs uppercase tracking-wider text-primary">
              {scope.type === "owner" ? "OWNER MEMORY" : "GUILD ID"}
            </p>
            <code className="rounded bg-base-300 px-1.5 py-0.5 font-mono text-xs">
              {scopeName(scope)}
            </code>
          </div>
          <p className="text-sm opacity-70">{entries.length.toLocaleString("ja-JP")} 件</p>
        </div>
        <details className="collapse collapse-arrow border border-base-300 bg-base-100">
          <summary className="collapse-title text-sm font-medium">ルールを追加</summary>
          <div className="collapse-content">
            <form
              className="flex flex-col gap-3"
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
                <span className="text-xs opacity-70">タイトル</span>
                <input
                  className="input w-full"
                  maxLength={200}
                  onChange={(event) => setRuleTitle((event.target as HTMLInputElement).value)}
                  required
                  value={ruleTitle}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs opacity-70">内容</span>
                <textarea
                  className="textarea w-full"
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
          </div>
        </details>
      </div>
      {entries.length === 0 ? (
        <EmptyState>このスコープのメモリは空です</EmptyState>
      ) : (
        <div className="max-h-[70vh] overflow-auto">
          <div className="flex flex-col gap-4">
            {entries.map((entry) => (
              <div key={entry.id} className="rounded-box border border-base-300 bg-base-200 p-4">
                <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                  <div className="flex flex-col items-start gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`badge badge-sm badge-soft ${
                          entry.kind === "rule" || entry.kind === "procedure"
                            ? "badge-warning"
                            : entry.kind === "decision"
                              ? "badge-info"
                              : "badge-ghost"
                        }`}
                      >
                        {entry.kind}
                      </span>
                      <span
                        className="badge badge-sm badge-outline"
                        title={entryScopeDetail(entry.scope)}
                      >
                        {entry.scope.type}
                      </span>
                    </div>
                    <h3 className="text-lg font-semibold">{entry.title}</h3>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs opacity-60">
                      更新 {formatTimestamp(entry.updatedAt)}
                    </span>
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
                </div>
                <p className="whitespace-pre-wrap break-words text-sm">{entry.content}</p>
                <hr className="my-3 border-base-300" />
                <div className="flex flex-wrap gap-4 text-xs opacity-60">
                  <span>作成 {formatTimestamp(entry.createdAt)}</span>
                  <span>
                    参照メッセージ {entry.sourceMessageIds.length.toLocaleString("ja-JP")} 件
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function scopeName(scope: MemoryScope): string {
  return scope.type === "owner" ? "オーナー" : scope.guildId;
}

function entryScopeDetail(scope: MemoryEntryScope): string {
  if (scope.type === "channel") return `チャンネル: ${scope.channelId}`;
  if (scope.type === "thread")
    return `スレッド: ${scope.threadId} (チャンネル: ${scope.channelId})`;
  return scope.type === "owner" ? "オーナー" : "ギルド全体";
}
