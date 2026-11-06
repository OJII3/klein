interface ErrorNoticeProps {
  message: string;
  onRetry: () => void;
  retryLabel?: string;
}

export function ErrorNotice({ message, onRetry, retryLabel = "再試行" }: ErrorNoticeProps) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-ember bg-ember/10 py-2.5 pr-3 pl-4"
      role="alert"
    >
      <p className="text-sm text-ember">{message}</p>
      <button className="btn btn-quiet text-ember" onClick={onRetry} type="button">
        {retryLabel}
      </button>
    </div>
  );
}

export function EmptyState({ children }: { children: string }) {
  return (
    <div className="border-y border-rule py-12 text-center">
      <p className="text-sm text-ink-faint">{children}</p>
    </div>
  );
}

export function LoadingState({ label = "読み込み中…" }: { label?: string }) {
  return (
    <div
      className="flex items-center justify-center gap-3 border-y border-rule py-12"
      role="status"
    >
      <span aria-hidden="true" className="spinner" />
      <span className="text-sm text-ink-faint">{label}</span>
    </div>
  );
}
