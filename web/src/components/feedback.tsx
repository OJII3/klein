interface ErrorNoticeProps {
  message: string;
  onRetry: () => void;
  retryLabel?: string;
}

export function ErrorNotice({ message, onRetry, retryLabel = "再試行" }: ErrorNoticeProps) {
  return (
    <div className="alert alert-error alert-soft" role="alert">
      <span className="flex-1 text-sm">{message}</span>
      <button className="btn btn-xs btn-error btn-soft" onClick={onRetry} type="button">
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
      <span aria-hidden="true" className="loading loading-spinner loading-sm text-primary" />
      <span className="text-sm text-ink-faint">{label}</span>
    </div>
  );
}
