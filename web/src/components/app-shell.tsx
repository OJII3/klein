import type { ComponentChildren } from "preact";

import { formatTimestamp } from "../lib/format";

export type View = "logs" | "sessions" | "memory";

interface AppShellProps {
  view: View;
  lastUpdated: Date | null;
  onViewChange: (view: View) => void;
  onRefresh: () => void;
  children: ComponentChildren;
}

const VIEWS: { value: View; label: string }[] = [
  { value: "logs", label: "▤ ログ" },
  { value: "sessions", label: "◌ Piセッション" },
  { value: "memory", label: "▣ メモリ" },
];

export function AppShell({ view, lastUpdated, onViewChange, onRefresh, children }: AppShellProps) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[1600px] flex-col gap-4 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="grid size-10 place-items-center rounded-box bg-primary/15 text-lg text-primary"
          >
            ◒
          </span>
          <h1 className="text-xl font-bold tracking-wide">KLEIN OBSERVATORY</h1>
        </div>
        <div className="flex items-center gap-3 text-xs opacity-70">
          <span>● ローカル接続</span>
          {lastUpdated && (
            <time dateTime={lastUpdated.toISOString()}>
              更新 {formatTimestamp(lastUpdated.toISOString())}
            </time>
          )}
          <button
            aria-label="再読み込み"
            className="btn btn-square btn-sm btn-soft btn-primary"
            onClick={onRefresh}
            type="button"
          >
            ↻
          </button>
        </div>
      </header>

      <nav aria-label="表示切り替え" className="tabs tabs-box w-fit">
        {VIEWS.map((item) => (
          <button
            key={item.value}
            aria-pressed={view === item.value}
            className={`tab ${view === item.value ? "tab-active" : ""}`}
            onClick={() => onViewChange(item.value)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </nav>

      <main>{children}</main>

      <footer className="pb-2 text-center text-xs opacity-60">Klein / local viewer</footer>
    </div>
  );
}
