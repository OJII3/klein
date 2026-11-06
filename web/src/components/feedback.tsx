interface ErrorNoticeProps {
  message: string;
  onRetry: () => void;
  retryLabel?: string;
}

export function ErrorNotice({ message, onRetry, retryLabel = "再試行" }: ErrorNoticeProps) {
  return (
    <div className="alert alert-error alert-soft items-start" role="alert">
      <div className="flex flex-col items-start gap-2">
        <span className="text-sm">{message}</span>
        <button className="btn btn-xs btn-error" onClick={onRetry} type="button">
          {retryLabel}
        </button>
      </div>
    </div>
  );
}

export function EmptyState({ children }: { children: string }) {
  return (
    <div className="flex min-h-24 items-center justify-center p-6">
      <p className="text-sm opacity-70">{children}</p>
    </div>
  );
}

export function LoadingState({ label = "読み込み中…" }: { label?: string }) {
  return (
    <div className="flex min-h-24 flex-col items-center justify-center gap-2 p-6" role="status">
      <span className="loading loading-spinner loading-sm" />
      <span className="text-sm opacity-70">{label}</span>
    </div>
  );
}
