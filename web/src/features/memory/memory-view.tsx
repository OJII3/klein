import type { ComponentChildren } from "preact";
import { useMemo, useState } from "preact/hooks";

import {
  memoryScopeKey,
  type MemoryEntry,
  type MemoryEntryScope,
  type MemoryKind,
  type MemoryScope,
  type MemoryScopeSummary,
  type MemorySelection,
  type UserMemory,
  type UserMemorySectionKey,
  type UserMemorySummary,
} from "../../api";
import { EmptyState, ErrorNotice, LoadingState } from "../../components/feedback";
import { Stat, StatStrip } from "../../components/stats";
import { ViewHeader } from "../../components/view-header";
import { formatCompactTimestamp, formatDate } from "../../lib/format";

interface MemoryViewProps {
  channelNames: ReadonlyMap<string, string>;
  enabled: boolean;
  userMemoryEnabled: boolean;
  scopes: MemoryScopeSummary[];
  users: UserMemorySummary[];
  selectedScope: MemorySelection | null;
  entries: MemoryEntry[];
  userMemory: UserMemory | null;
  loading: boolean;
  loadingDetail: boolean;
  error: string | null;
  detailError: string | null;
  deleteError: string | null;
  deletingEntryId: string | null;
  deletingUserMemory: boolean;
  addingRule: boolean;
  addRuleError: string | null;
  onSelect: (scope: MemorySelection) => void;
  onDelete: (entryId: string) => void;
  onDeleteUserMemory: (userId: string) => void;
  onAddRule: (title: string, content: string) => void;
  onDismissDeleteError: () => void;
  onRetry: () => void;
  onRetryDetail: () => void;
}

const MEMORY_KINDS: readonly MemoryKind[] = ["fact", "rule", "decision", "procedure", "temporary"];

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

const USER_SECTIONS: readonly { key: UserMemorySectionKey; label: string }[] = [
  { key: "facts", label: "事実" },
  { key: "history", label: "履歴" },
  { key: "inCommon", label: "共通点" },
  { key: "strengthening", label: "関係の強化" },
];

export function MemoryView(props: MemoryViewProps) {
  const {
    channelNames,
    enabled,
    userMemoryEnabled,
    scopes,
    users,
    selectedScope,
    entries,
    userMemory,
    loading,
    loadingDetail,
    error,
    detailError,
    deleteError,
    deletingEntryId,
    deletingUserMemory,
    addingRule,
    addRuleError,
    onSelect,
    onDelete,
    onDeleteUserMemory,
    onAddRule,
    onDismissDeleteError,
    onRetry,
    onRetryDetail,
  } = props;
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();

  const ownerSummary = scopes.find((summary) => summary.scope.type === "owner");
  const guilds = useMemo(
    () =>
      scopes
        .filter((summary) => summary.scope.type === "guild")
        .filter(
          (summary) =>
            summary.scope.type === "guild" &&
            (!normalizedQuery ||
              `guild ${summary.scope.guildId} ギルド`.toLowerCase().includes(normalizedQuery)),
        ),
    [normalizedQuery, scopes],
  );
  const filteredUsers = useMemo(
    () =>
      normalizedQuery
        ? users.filter((user) =>
            `${user.displayName} ${user.discordId} ${user.userId} ${user.summary}`
              .toLowerCase()
              .includes(normalizedQuery),
          )
        : users,
    [normalizedQuery, users],
  );

  const guildCount = scopes.filter((summary) => summary.scope.type === "guild").length;
  const entryCount = scopes.reduce((sum, summary) => sum + summary.entryCount, 0);
  const hasMemories = scopes.length > 0 || users.length > 0;

  return (
    <section className="flex flex-col gap-4" aria-labelledby="memory-heading">
      <ViewHeader headingId="memory-heading" title="メモリ">
        <StatStrip>
          <Stat label="ギルド" value={guildCount.toLocaleString("ja-JP")} />
          <Stat label="ユーザー" value={users.length.toLocaleString("ja-JP")} />
          <Stat label="エントリ" value={entryCount.toLocaleString("ja-JP")} />
        </StatStrip>
      </ViewHeader>

      {error && <ErrorNotice message={error} onRetry={onRetry} />}
      {!error && !enabled && !userMemoryEnabled ? (
        <div className="card border border-base-300 bg-base-100">
          <EmptyState>メモリ機能が無効です</EmptyState>
        </div>
      ) : loading && !hasMemories ? (
        <div className="card border border-base-300 bg-base-100">
          <LoadingState />
        </div>
      ) : !hasMemories ? (
        <div className="card border border-base-300 bg-base-100">
          <EmptyState>保存されたメモリがまだありません</EmptyState>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[19rem_minmax(0,1fr)] lg:items-start">
          <div className="card overflow-hidden border border-base-300 bg-base-100 lg:sticky lg:top-[4.25rem]">
            <div className="border-b border-line p-2.5">
              <input
                aria-label="メモリを検索"
                className="input input-sm w-full"
                onChange={(event) => setQuery((event.target as HTMLInputElement).value)}
                placeholder="名前・ID で絞り込み"
                type="search"
                value={query}
              />
            </div>

            <div className="max-h-72 overflow-y-auto lg:max-h-[calc(100vh-12rem)]">
              {ownerSummary && (
                <ScopeGroup title="オーナー">
                  <ScopeItem
                    badge={`${ownerSummary.entryCount} 件`}
                    meta={`更新 ${formatCompactTimestamp(ownerSummary.updatedAt ?? undefined)}`}
                    onClick={() => onSelect(ownerSummary.scope)}
                    selected={
                      selectedScope !== null &&
                      memoryScopeKey(selectedScope) === memoryScopeKey(ownerSummary.scope)
                    }
                    title="オーナーのメモリ"
                  />
                </ScopeGroup>
              )}

              {guildCount > 0 && (
                <ScopeGroup count={guilds.length} title="ギルド">
                  {guilds.length === 0 ? (
                    <p className="px-3 py-2 text-[0.68rem] text-ink-faint">該当なし</p>
                  ) : (
                    guilds.map((summary) => (
                      <ScopeItem
                        badge={`${summary.entryCount} 件`}
                        key={memoryScopeKey(summary.scope)}
                        meta={`更新 ${formatCompactTimestamp(summary.updatedAt ?? undefined)}`}
                        onClick={() => onSelect(summary.scope)}
                        selected={
                          selectedScope !== null &&
                          memoryScopeKey(selectedScope) === memoryScopeKey(summary.scope)
                        }
                        subtitle={
                          summary.scope.type === "guild" ? summary.scope.guildId : undefined
                        }
                        title="ギルドのメモリ"
                      />
                    ))
                  )}
                </ScopeGroup>
              )}

              <ScopeGroup count={filteredUsers.length} title="ユーザー">
                {!userMemoryEnabled ? (
                  <p className="px-3 py-2 text-[0.68rem] text-ink-faint">
                    ユーザーメモリが無効です
                  </p>
                ) : filteredUsers.length === 0 ? (
                  <p className="px-3 py-2 text-[0.68rem] text-ink-faint">
                    {users.length === 0 ? "まだユーザーメモリがありません" : "該当なし"}
                  </p>
                ) : (
                  filteredUsers.map((user) => (
                    <ScopeItem
                      badge={formatImpression(user.impression)}
                      badgeTone={impressionTone(user.impression)}
                      key={user.userId}
                      meta={`更新 ${formatCompactTimestamp(user.updatedAt)}`}
                      onClick={() => onSelect({ type: "user", userId: user.userId })}
                      selected={
                        selectedScope?.type === "user" && selectedScope.userId === user.userId
                      }
                      subtitle={`@${user.discordId}`}
                      title={user.displayName}
                    />
                  ))
                )}
              </ScopeGroup>
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
              ) : selectedScope?.type === "user" ? (
                userMemory ? (
                  <UserMemoryDetail
                    deleting={deletingUserMemory}
                    memory={userMemory}
                    onDelete={onDeleteUserMemory}
                    userId={selectedScope.userId}
                  />
                ) : (
                  <EmptyState>ユーザーメモリを読み込めませんでした</EmptyState>
                )
              ) : selectedScope ? (
                <MemoryEntries
                  addingRule={addingRule}
                  addRuleError={addRuleError}
                  channelNames={channelNames}
                  deletingEntryId={deletingEntryId}
                  entries={entries}
                  key={memoryScopeKey(selectedScope)}
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

function ScopeGroup({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ComponentChildren;
}) {
  return (
    <div className="border-b border-line last:border-b-0">
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-[0.66rem] font-medium tracking-wide text-ink-faint">{title}</span>
        {count !== undefined && (
          <span className="font-mono text-[0.6rem] text-ink-faint">{count}</span>
        )}
      </div>
      <div className="pb-1">{children}</div>
    </div>
  );
}

function ScopeItem({
  title,
  subtitle,
  badge,
  badgeTone = "text-ink-faint",
  meta,
  selected,
  onClick,
}: {
  title: string;
  subtitle?: string;
  badge: string;
  badgeTone?: string;
  meta: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-current={selected ? "true" : undefined}
      className={`flex w-full flex-col items-stretch gap-0.5 px-3 py-2 text-left transition-colors ${
        selected ? "bg-green-soft" : "hover:bg-base-200"
      }`}
      onClick={onClick}
      type="button"
    >
      <span className="flex items-baseline justify-between gap-2">
        <span
          className={`truncate text-[0.8rem] font-medium ${
            selected ? "text-green-strong" : "text-ink"
          }`}
        >
          {title}
        </span>
        <span className={`shrink-0 font-mono text-[0.62rem] ${badgeTone}`}>{badge}</span>
      </span>
      {subtitle && (
        <span className="truncate font-mono text-[0.62rem] text-ink-faint">{subtitle}</span>
      )}
      <span className="font-mono text-[0.62rem] text-ink-faint">{meta}</span>
    </button>
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
  const [kindFilter, setKindFilter] = useState<MemoryKind | "all">("all");

  const sortedEntries = useMemo(
    () => entries.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [entries],
  );
  const kindCounts = useMemo(() => {
    const counts = new Map<MemoryKind, number>();
    for (const entry of entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
    return counts;
  }, [entries]);
  const visibleEntries =
    kindFilter === "all"
      ? sortedEntries
      : sortedEntries.filter((entry) => entry.kind === kindFilter);

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

      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2">
        <FilterChip
          active={kindFilter === "all"}
          count={entries.length}
          label="すべて"
          onClick={() => setKindFilter("all")}
        />
        {MEMORY_KINDS.map((kind) => {
          const count = kindCounts.get(kind) ?? 0;
          if (count === 0) return null;
          return (
            <FilterChip
              active={kindFilter === kind}
              count={count}
              key={kind}
              label={KIND_LABELS[kind]}
              onClick={() => setKindFilter(kind)}
            />
          );
        })}
      </div>

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

      {visibleEntries.length === 0 ? (
        <EmptyState>
          {entries.length === 0 ? "このスコープのメモリは空です" : "この種類のメモリはありません"}
        </EmptyState>
      ) : (
        <div className="divide-y divide-line">
          {visibleEntries.map((entry) => (
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

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={`btn btn-xs gap-1 ${active ? "btn-primary" : "btn-ghost border border-base-300"}`}
      onClick={onClick}
      type="button"
    >
      {label}
      <span className="font-mono text-[0.6rem] opacity-70">{count}</span>
    </button>
  );
}

function UserMemoryDetail({
  memory,
  userId,
  deleting,
  onDelete,
}: {
  memory: UserMemory;
  userId: string;
  deleting: boolean;
  onDelete: (userId: string) => void;
}) {
  const realName = [memory.lastName, memory.firstName].filter(Boolean).join(" ");

  return (
    <div className="flex min-w-0 flex-col">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-4 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[1.05rem] font-semibold text-ink">{memory.displayName}</h2>
            {memory.nickname && (
              <span className="badge badge-ghost badge-sm">{memory.nickname}</span>
            )}
          </div>
          <p className="mt-1 truncate font-mono text-[0.64rem] text-ink-faint">
            @{memory.discordId}
          </p>
          <p className="mt-0.5 truncate font-mono text-[0.62rem] text-ink-faint">
            {realName || "本名は未登録"} · 更新 {formatCompactTimestamp(memory.updatedAt)}
          </p>
        </div>
        <div className="flex shrink-0 items-start gap-3">
          <ImpressionMeter value={memory.impression} />
          <button
            className="btn btn-error btn-soft btn-xs"
            disabled={deleting}
            onClick={() => {
              if (
                window.confirm(
                  `「${memory.displayName}」のユーザーメモリを削除しますか？\nこの操作は元に戻せません。次にこのユーザーが発言すると、新しいメモリが作られます。`,
                )
              )
                onDelete(userId);
            }}
            type="button"
          >
            {deleting ? "削除中…" : "削除"}
          </button>
        </div>
      </header>

      <section className="border-b border-line px-4 py-4">
        <h3 className="text-[0.68rem] font-medium tracking-wide text-ink-faint">要約</h3>
        <p className="mt-1.5 max-w-[60rem] text-[0.84rem] leading-6 break-words whitespace-pre-wrap text-ink-soft">
          {memory.summary || "—"}
        </p>
      </section>

      {USER_SECTIONS.map((section) => (
        <section className="border-b border-line px-4 py-4" key={section.key}>
          <h3 className="text-[0.68rem] font-medium tracking-wide text-ink-faint">
            {section.label}
          </h3>
          <p className="mt-1.5 max-w-[60rem] text-[0.82rem] leading-6 break-words whitespace-pre-wrap text-ink-soft">
            {memory[section.key]}
          </p>
        </section>
      ))}
    </div>
  );
}

function ImpressionMeter({ value }: { value: number }) {
  const width = Math.abs(value) / 2;
  return (
    <div className="flex w-40 shrink-0 flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[0.62rem] text-ink-faint">印象</span>
        <span className={`font-mono text-[0.72rem] font-medium ${impressionTone(value)}`}>
          {formatImpression(value)}
        </span>
      </div>
      <div
        aria-label={`印象 ${value}`}
        className="relative h-1.5 overflow-hidden rounded-full bg-base-300"
        role="img"
      >
        <span aria-hidden="true" className="absolute inset-y-0 left-1/2 w-px bg-line-strong" />
        <span
          aria-hidden="true"
          className={`absolute inset-y-0 ${value >= 0 ? "left-1/2 bg-green" : "right-1/2 bg-red"}`}
          style={{ width: `${width}%` }}
        />
      </div>
      <span className="text-[0.6rem] text-ink-faint">{impressionLabel(value)}</span>
    </div>
  );
}

function formatImpression(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function impressionTone(value: number): string {
  if (value > 0) return "text-green-strong";
  if (value < 0) return "text-red";
  return "text-ink-faint";
}

function impressionLabel(value: number): string {
  if (value >= 50) return "とても好意的";
  if (value > 0) return "好意的";
  if (value <= -50) return "とても否定的";
  if (value < 0) return "否定的";
  return "中立";
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
