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
  { value: "sessions", label: "セッション" },
  { value: "memory", label: "メモリ" },
];

interface NavLinksProps {
  view: View;
  className: string;
  onViewChange: (view: View) => void;
}

function NavLinks({ view, className, onViewChange }: NavLinksProps) {
  return (
    <nav aria-label="表示切り替え" className={className}>
      {VIEWS.map((item) => {
        const active = view === item.value;
        return (
          <a
            key={item.value}
            aria-current={active ? "page" : undefined}
            className="nav-link"
            href={`/${item.value}`}
            onClick={(event) => {
              event.preventDefault();
              onViewChange(item.value);
            }}
          >
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}

export function AppShell({ view, lastUpdated, onViewChange, onRefresh, children }: AppShellProps) {
  const updatedAt = lastUpdated?.toISOString();

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-[88rem] items-center gap-3 px-4 sm:px-6 lg:px-8">
          <a
            className="flex items-center gap-2"
            href="/logs"
            onClick={(event) => {
              event.preventDefault();
              onViewChange("logs");
            }}
          >
            <span className="grid size-7 place-items-center rounded bg-green text-[0.8rem] font-semibold text-white">
              K
            </span>
            <span className="text-[0.95rem] font-semibold tracking-tight text-ink">Klein</span>
          </a>

          <NavLinks
            className="ml-4 hidden items-center gap-0.5 md:flex"
            onViewChange={onViewChange}
            view={view}
          />

          <div className="ml-auto flex items-center gap-2.5 text-xs sm:gap-3">
            <span className="flex items-center gap-1.5 text-ink-soft">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-green" />
              <span className="hidden sm:inline">ローカル接続</span>
            </span>
            {updatedAt && (
              <time
                className="font-mono text-[0.68rem] text-ink-faint"
                dateTime={updatedAt}
                title={`更新 ${formatTimestamp(updatedAt)}`}
              >
                更新 {formatClock(updatedAt)}
              </time>
            )}
            <button className="btn btn-xs" onClick={onRefresh} type="button">
              ↻<span className="hidden sm:inline">再読み込み</span>
            </button>
          </div>
        </div>

        <div className="border-t border-line px-3 py-1.5 md:hidden">
          <NavLinks
            className="flex items-center gap-0.5 overflow-x-auto"
            onViewChange={onViewChange}
            view={view}
          />
        </div>
      </header>

      <main className="mx-auto w-full max-w-[88rem] px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
        <div className="flex flex-col gap-4">{children}</div>
      </main>
    </div>
  );
}
