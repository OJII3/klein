interface ErrorNoticeProps {
  message: string;
  onRetry: () => void;
  retryLabel?: string;
}

export function ErrorNotice({ message, onRetry, retryLabel = "再試行" }: ErrorNoticeProps) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red/25 bg-red-soft px-4 py-3"
      role="alert"
    >
      <p className="text-sm text-red">{message}</p>
      <button className="btn btn-xs btn-danger" onClick={onRetry} type="button">
        {retryLabel}
      </button>
    </div>
  );
}

export function EmptyState({ children }: { children: string }) {
  return (
    <div className="px-4 py-12 text-center">
      <p className="text-sm text-ink-faint">{children}</p>
    </div>
  );
}

export function LoadingState({ label = "読み込み中…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2.5 px-4 py-12" role="status">
      <span aria-hidden="true" className="spinner" />
      <span className="text-sm text-ink-faint">{label}</span>
    </div>
  );
}
