import type { ComponentChildren } from "preact";

import { formatClock, formatTimestamp } from "../lib/format";

export type View = "logs" | "sessions" | "memory";

interface AppShellProps {
  view: View;
  lastUpdated: Date | null;
  onViewChange: (view: View) => void;
  onRefresh: () => void;
  children: ComponentChildren;
}

const VIEWS: { value: View; label: string }[] = [
  { value: "logs", label: "ログ" },
  { value: "sessions", label: "Pi セッション" },
  { value: "memory", label: "メモリ" },
];

export function AppShell({ view, lastUpdated, onViewChange, onRefresh, children }: AppShellProps) {
  const updatedAt = lastUpdated?.toISOString();

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[13.5rem_minmax(0,1fr)]">
      <aside className="border-b border-rule bg-night-900/50 lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col lg:border-r lg:border-b-0">
        <div className="flex items-center justify-between gap-4 px-5 py-5 lg:block lg:px-6 lg:pt-8 lg:pb-10">
          <div>
            <p className="font-serif text-[1.35rem] leading-none tracking-[0.16em] text-ink">
              KLEIN
            </p>
            <p className="mt-1.5 font-mono text-[0.6rem] tracking-[0.3em] text-ink-faint">
              OBSERVATORY
            </p>
          </div>
          <div className="flex items-center gap-2.5 lg:hidden">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-moss" />
            {updatedAt && (
              <time className="font-mono text-[0.65rem] text-ink-faint" dateTime={updatedAt}>
                {formatClock(updatedAt)}
              </time>
            )}
            <button
              aria-label="再読み込み"
              className="btn btn-xs"
              onClick={onRefresh}
              type="button"
            >
              ↻
            </button>
          </div>
        </div>

        <nav
          aria-label="表示切り替え"
          className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:gap-0.5 lg:px-3 lg:pb-0"
        >
          {VIEWS.map((item) => {
            const active = view === item.value;
            return (
              <a
                key={item.value}
                aria-current={active ? "page" : undefined}
                className="rail-link"
                href={`/${item.value}`}
                onClick={(event) => {
                  event.preventDefault();
                  onViewChange(item.value);
                }}
              >
                <span className="text-sm">{item.label}</span>
              </a>
            );
          })}
        </nav>

        <div className="mt-auto hidden border-t border-rule px-6 py-5 lg:block">
          <p className="flex items-center gap-2 text-xs text-ink-soft">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-moss" />
            ローカル接続
          </p>
          <p className="mt-2 font-mono text-[0.66rem] leading-relaxed text-ink-faint">
            {updatedAt ? `更新 ${formatTimestamp(updatedAt)}` : "まだ更新されていません"}
          </p>
          <button className="btn btn-xs mt-3 w-full" onClick={onRefresh} type="button">
            再読み込み
          </button>
        </div>
      </aside>

      <main className="min-w-0 px-5 py-6 sm:px-8 sm:py-8 lg:px-10 lg:py-10">
        <div className="mx-auto flex w-full max-w-[78rem] flex-col gap-6">
          {children}
          <footer className="mt-4 border-t border-rule pt-4 font-mono text-[0.65rem] tracking-wide text-ink-faint">
            Klein / local viewer
          </footer>
        </div>
      </main>
    </div>
  );
}
