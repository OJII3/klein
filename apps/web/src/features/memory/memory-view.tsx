import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

import {
  sharedMemoryScopeKey,
  memoryScopeKey,
  type SharedMemoryFile,
  type SharedMemoryScope,
  type MemoryScopeSummary,
  type MemorySelection,
  type UserMemory,
  type UserMemorySectionKey,
  type UserMemorySummary,
} from "../../api";
import { EmptyState, ErrorNotice, LoadingState } from "../../components/feedback";
import { Stat, StatStrip } from "../../components/stats";
import { ViewHeader } from "../../components/view-header";
import { formatCompactTimestamp } from "../../lib/format";

interface MemoryViewProps {
  channelNames: ReadonlyMap<string, string>;
  guildNames: ReadonlyMap<string, string>;
  enabled: boolean;
  userMemoryEnabled: boolean;
  scopes: readonly MemoryScopeSummary[];
  users: readonly UserMemorySummary[];
  selectedScope: MemorySelection | null;
  sharedMemory: readonly SharedMemoryFile[] | null;
  userMemory: UserMemory | null;
  loading: boolean;
  loadingDetail: boolean;
  error: string | null;
  detailError: string | null;
  deletingUserMemory: boolean;
  deletingFileKey: string | null;
  savingFileKey: string | null;
  fileError: string | null;
  onSelect: (scope: MemorySelection) => void;
  onDeleteUserMemory: (userId: string) => void;
  onSaveFile: (scope: SharedMemoryScope, content: string) => Promise<boolean>;
  onDeleteFile: (scope: SharedMemoryScope) => Promise<boolean>;
  onDismissFileError: () => void;
  onRetry: () => void;
  onRetryDetail: () => void;
}

const USER_SECTIONS: readonly { key: UserMemorySectionKey; label: string }[] = [
  { key: "facts", label: "事実" },
  { key: "history", label: "履歴" },
  { key: "inCommon", label: "共通点" },
  { key: "strengthening", label: "関係の強化" },
];

export function MemoryView(props: MemoryViewProps) {
  const {
    channelNames,
    guildNames,
    enabled,
    userMemoryEnabled,
    scopes,
    users,
    selectedScope,
    sharedMemory,
    userMemory,
    loading,
    loadingDetail,
    error,
    detailError,
    deletingUserMemory,
    deletingFileKey,
    savingFileKey,
    fileError,
    onSelect,
    onDeleteUserMemory,
    onSaveFile,
    onDeleteFile,
    onDismissFileError,
    onRetry,
    onRetryDetail,
  } = props;
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();

  const guilds = useMemo(
    () =>
      scopes
        .filter((summary) => summary.scope.type === "guild")
        .filter(
          (summary) =>
            !normalizedQuery ||
            `${summary.scope.guildId} ${guildNames.get(summary.scope.guildId) ?? ""} ギルド`
              .toLowerCase()
              .includes(normalizedQuery),
        ),
    [guildNames, normalizedQuery, scopes],
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

  const entryCount = scopes.reduce((sum, summary) => sum + summary.entryCount, 0);
  const hasMemories = scopes.length > 0 || users.length > 0;

  return (
    <section className="flex flex-col gap-4" aria-labelledby="memory-heading">
      <ViewHeader headingId="memory-heading" title="メモリ">
        <StatStrip>
          <Stat label="ギルド" value={scopes.length.toLocaleString("ja-JP")} />
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
                onChange={(event) => {
                  if (event.target instanceof HTMLInputElement) setQuery(event.target.value);
                }}
                placeholder="名前・ID で絞り込み"
                type="search"
                value={query}
              />
            </div>

            <div className="max-h-72 overflow-y-auto lg:max-h-[calc(100vh-12rem)]">
              {scopes.length > 0 && (
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
                        subtitle={summary.scope.guildId}
                        title={guildNames.get(summary.scope.guildId) ?? "共有メモリ"}
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
            {fileError && (
              <ErrorNotice message={fileError} onRetry={onDismissFileError} retryLabel="閉じる" />
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
              ) : selectedScope?.type === "guild" ? (
                <SharedMemoryDetail
                  channelNames={channelNames}
                  deletingFileKey={deletingFileKey}
                  files={sharedMemory ?? []}
                  guildId={selectedScope.guildId}
                  guildName={guildNames.get(selectedScope.guildId)}
                  onDelete={onDeleteFile}
                  onSave={onSaveFile}
                  savingFileKey={savingFileKey}
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

function SharedMemoryDetail({
  files,
  guildId,
  guildName,
  channelNames,
  savingFileKey,
  deletingFileKey,
  onSave,
  onDelete,
}: {
  files: readonly SharedMemoryFile[];
  guildId: string;
  guildName?: string;
  channelNames: ReadonlyMap<string, string>;
  savingFileKey: string | null;
  deletingFileKey: string | null;
  onSave: (scope: SharedMemoryScope, content: string) => Promise<boolean>;
  onDelete: (scope: SharedMemoryScope) => Promise<boolean>;
}) {
  const visibleFiles = files.filter((file) => file.content.trim().length > 0);

  return (
    <div className="flex min-w-0 flex-col">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-4">
        <div className="min-w-0">
          <h2 className="text-[1.05rem] font-semibold text-ink">{guildName ?? "共有メモリ"}</h2>
          <p className="mt-1 truncate font-mono text-[0.64rem] text-ink-faint">guild {guildId}</p>
        </div>
        <p className="shrink-0 font-mono text-[0.68rem] text-ink-faint">
          {visibleFiles.length.toLocaleString("ja-JP")} ファイル
        </p>
      </header>

      {visibleFiles.length === 0 ? (
        <EmptyState>このギルドの共有メモリは空です</EmptyState>
      ) : (
        <div className="divide-y divide-line">
          {visibleFiles.map((file) => (
            <SharedMemoryFileCard
              channelNames={channelNames}
              deleting={deletingFileKey === sharedMemoryScopeKey(file.scope)}
              file={file}
              key={sharedMemoryScopeKey(file.scope)}
              onDelete={() => onDelete(file.scope)}
              onSave={(content) => onSave(file.scope, content)}
              saving={savingFileKey === sharedMemoryScopeKey(file.scope)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SharedMemoryFileCard({
  file,
  channelNames,
  saving,
  deleting,
  onSave,
  onDelete,
}: {
  file: SharedMemoryFile;
  channelNames: ReadonlyMap<string, string>;
  saving: boolean;
  deleting: boolean;
  onSave: (content: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(file.content);

  useEffect(() => {
    if (!editing) setDraft(file.content);
  }, [editing, file.content]);

  const label = sharedMemoryScopeLabel(file.scope, channelNames);

  return (
    <section className="px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[0.9rem] font-semibold text-ink">{label}</h3>
          <p className="mt-0.5 font-mono text-[0.62rem] text-ink-faint">
            {sharedMemoryRelativePath(file.scope)} · 更新 {formatCompactTimestamp(file.updatedAt)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {editing ? (
            <>
              <button
                className="btn btn-ghost btn-xs"
                onClick={() => {
                  setDraft(file.content);
                  setEditing(false);
                }}
                type="button"
              >
                キャンセル
              </button>
              <button
                className="btn btn-primary btn-xs"
                disabled={saving}
                onClick={() => {
                  void (async () => {
                    if (await onSave(draft)) setEditing(false);
                  })();
                }}
                type="button"
              >
                {saving ? "保存中…" : "保存"}
              </button>
            </>
          ) : (
            <button
              className="btn btn-ghost btn-xs"
              onClick={() => {
                setDraft(file.content);
                setEditing(true);
              }}
              type="button"
            >
              編集
            </button>
          )}
          <button
            className="btn btn-error btn-soft btn-xs"
            disabled={deleting || saving}
            onClick={() => {
              if (
                window.confirm(
                  `「${label}」のメモリファイルを削除しますか？\nこの操作は元に戻せません。`,
                )
              )
                void onDelete();
            }}
            type="button"
          >
            {deleting ? "削除中…" : "削除"}
          </button>
        </div>
      </div>

      {editing ? (
        <textarea
          aria-label={`${label} の内容`}
          className="textarea mt-3 min-h-[20rem] w-full resize-y font-mono text-[0.78rem] leading-6"
          onChange={(event) => {
            if (event.target instanceof HTMLTextAreaElement) setDraft(event.target.value);
          }}
          value={draft}
        />
      ) : (
        <pre className="mt-3 max-h-[36rem] overflow-auto rounded border border-line bg-surface-muted p-3 font-mono text-[0.76rem] leading-6 whitespace-pre-wrap break-words text-ink-soft">
          {file.content}
        </pre>
      )}
    </section>
  );
}

function sharedMemoryRelativePath(scope: SharedMemoryScope): string {
  if (scope.type === "guild") return "MEMORY.md";
  if (scope.type === "channel") return `${scope.channelId}/MEMORY.md`;
  return `${scope.channelId}/${scope.threadId}/MEMORY.md`;
}

function sharedMemoryScopeLabel(
  scope: SharedMemoryScope,
  channelNames: ReadonlyMap<string, string>,
): string {
  const label = (channelId: string): string => channelNames.get(channelId) ?? channelId;
  if (scope.type === "guild") return "ギルド全体";
  if (scope.type === "channel") return `#${label(scope.channelId)}`;
  return `${label(scope.threadId)} (#${label(scope.channelId)})`;
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
      <meter
        aria-label={`印象 ${value}`}
        className="sr-only"
        high={50}
        low={-50}
        max={100}
        min={-100}
        optimum={50}
        value={value}
      >
        {formatImpression(value)} ({impressionLabel(value)})
      </meter>
      <div aria-hidden="true" className="relative h-1.5 overflow-hidden rounded-full bg-base-300">
        <span className="absolute inset-y-0 left-1/2 w-px bg-line-strong" />
        <span
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
