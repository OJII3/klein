interface ErrorNoticeProps {
  message: string;
  onRetry: () => void;
  retryLabel?: string;
}

export function ErrorNotice({ message, onRetry, retryLabel = "再試行" }: ErrorNoticeProps) {
  return (
    <div className="notice notice-error" role="alert">
      <span>{message}</span>
      <button className="button button-small" onClick={onRetry} type="button">
        {retryLabel}
      </button>
    </div>
  );
}

export function EmptyState({ children }: { children: string }) {
  return <div className="empty-state">{children}</div>;
}

export function LoadingState({ label = "読み込み中…" }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}
