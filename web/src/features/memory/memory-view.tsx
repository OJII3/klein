import type { MemoryEntry, MemoryGuildSummary } from "../../api";
import { EmptyState, ErrorNotice, LoadingState } from "../../components/feedback";
import { formatTimestamp } from "../../lib/format";

interface MemoryViewProps {
  enabled: boolean;
  guilds: MemoryGuildSummary[];
  selectedGuildId: string | null;
  entries: MemoryEntry[];
  loading: boolean;
  loadingDetail: boolean;
  error: string | null;
  detailError: string | null;
  deleteError: string | null;
  deletingEntryId: string | null;
  onSelect: (guildId: string) => void;
  onDelete: (entryId: string) => void;
  onDismissDeleteError: () => void;
  onRetry: () => void;
  onRetryDetail: () => void;
}

export function MemoryView({
  enabled,
  guilds,
  selectedGuildId,
  entries,
  loading,
  loadingDetail,
  error,
  detailError,
  deleteError,
  deletingEntryId,
  onSelect,
  onDelete,
  onDismissDeleteError,
  onRetry,
  onRetryDetail,
}: MemoryViewProps) {
  return (
    <section className="view-section" aria-labelledby="memory-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">PERSISTED GUILD CONTEXT</p>
          <h2 id="memory-heading">メモリ</h2>
        </div>
        <span className="result-count">{guilds.length.toLocaleString("ja-JP")} ギルド</span>
      </div>

      {error && <ErrorNotice message={error} onRetry={onRetry} />}
      {!error && !enabled ? (
        <EmptyState>メモリ機能が無効です</EmptyState>
      ) : loading && guilds.length === 0 ? (
        <LoadingState />
      ) : guilds.length === 0 ? (
        <EmptyState>保存されたメモリがまだありません</EmptyState>
      ) : (
        <div className="memory-layout">
          <div className="session-list" aria-label="ギルドメモリ一覧">
            {guilds.map((guild) => (
              <button
                className={`session-list-item${selectedGuildId === guild.guildId ? " is-selected" : ""}`}
                key={guild.guildId}
                onClick={() => onSelect(guild.guildId)}
                type="button"
              >
                <span className="session-list-topline">
                  <span className="session-channel">GUILD</span>
                  <span className="session-count">{guild.entryCount} 件</span>
                </span>
                <strong className="mono">{guild.guildId}</strong>
                <time dateTime={guild.updatedAt ?? undefined}>
                  更新 {formatTimestamp(guild.updatedAt ?? undefined)}
                </time>
              </button>
            ))}
          </div>

          <div className="memory-detail">
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
            ) : selectedGuildId ? (
              <MemoryEntries
                deletingEntryId={deletingEntryId}
                entries={entries}
                guildId={selectedGuildId}
                onDelete={onDelete}
              />
            ) : (
              <EmptyState>ギルドを選択してください</EmptyState>
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
  guildId,
  onDelete,
}: {
  deletingEntryId: string | null;
  entries: MemoryEntry[];
  guildId: string;
  onDelete: (entryId: string) => void;
}) {
  return (
    <div className="memory-panel">
      <div className="memory-panel-heading">
        <div>
          <p className="eyebrow">GUILD ID</p>
          <h3 className="mono">{guildId}</h3>
        </div>
        <span className="result-count">{entries.length.toLocaleString("ja-JP")} 件</span>
      </div>
      {entries.length === 0 ? (
        <EmptyState>このギルドのメモリは空です</EmptyState>
      ) : (
        <div className="memory-entries">
          {entries.map((entry) => (
            <article className="memory-entry" key={entry.id}>
              <div className="memory-entry-heading">
                <div>
                  <span className={`memory-kind memory-kind-${entry.kind}`}>{entry.kind}</span>
                  <h3>{entry.title}</h3>
                </div>
                <div className="memory-entry-actions">
                  <time dateTime={entry.updatedAt}>更新 {formatTimestamp(entry.updatedAt)}</time>
                  <button
                    className="button button-danger button-small"
                    disabled={deletingEntryId !== null}
                    onClick={() => {
                      if (
                        window.confirm(
                          `「${entry.title}」を削除しますか？\nこの操作は元に戻せません。`,
                        )
                      ) {
                        onDelete(entry.id);
                      }
                    }}
                    type="button"
                  >
                    {deletingEntryId === entry.id ? "削除中…" : "削除"}
                  </button>
                </div>
              </div>
              <p className="memory-content">{entry.content}</p>
              <dl className="memory-meta">
                <div>
                  <dt>作成</dt>
                  <dd>{formatTimestamp(entry.createdAt)}</dd>
                </div>
                <div>
                  <dt>参照メッセージ</dt>
                  <dd>{entry.sourceMessageIds.length.toLocaleString("ja-JP")} 件</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
