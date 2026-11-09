import type { ComponentChildren } from "preact";

import { formatClock, formatTimestamp } from "../lib/format";
import type { View } from "../router";
import { Link } from "./link";

interface AppShellProps {
  view: View;
  lastUpdated: Date | null;
  onRefresh: () => void;
  children: ComponentChildren;
}

const VIEWS: { value: View; label: string }[] = [
  { value: "logs", label: "ログ" },
  { value: "sessions", label: "セッション" },
  { value: "tools", label: "ツール" },
  { value: "memory", label: "メモリ" },
];

interface NavLinksProps {
  view: View;
  className: string;
}

function NavLinks({ view, className }: NavLinksProps) {
  return (
    <nav aria-label="表示切り替え" className={className}>
      <ul className="menu menu-horizontal menu-sm gap-0.5 p-0 [--menu-active-bg:var(--color-green-soft)] [--menu-active-fg:var(--color-green-strong)]">
        {VIEWS.map((item) => {
          const active = view === item.value;
          return (
            <li key={item.value}>
              <Link aria-current={active ? "page" : undefined} href={`/${item.value}`}>
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function AppShell({ view, lastUpdated, onRefresh, children }: AppShellProps) {
  const updatedAt = lastUpdated?.toISOString();

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-base-300 bg-base-100">
        <div className="navbar mx-auto h-14 min-h-0 max-w-[88rem] gap-3 px-4 sm:px-6 lg:px-8">
          <div className="navbar-start gap-3">
            <Link className="flex items-center gap-2" href="/logs">
              <div className="avatar avatar-placeholder">
                <div className="w-7 rounded bg-primary">
                  <span className="text-[0.8rem] font-semibold text-primary-content">K</span>
                </div>
              </div>
              <span className="text-[0.95rem] font-semibold tracking-tight text-ink">Klein</span>
            </Link>

            <NavLinks className="ml-4 hidden items-center md:flex" view={view} />
          </div>

          <div className="navbar-end gap-2.5 text-xs sm:gap-3">
            <span className="flex items-center gap-1.5 text-ink-soft">
              <span aria-hidden="true" className="status status-success" />
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

        <div className="border-t border-base-300 px-3 py-1.5 md:hidden">
          <NavLinks className="flex items-center overflow-x-auto" view={view} />
        </div>
      </header>

      <main className="mx-auto w-full max-w-[88rem] px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
        <div className="flex flex-col gap-4">{children}</div>
      </main>
    </div>
  );
}
