import type { ReactNode } from "react";
import { ActionIcon, SegmentedControl, Text } from "@mantine/core";

import { formatTimestamp } from "../lib/format";

export type View = "logs" | "sessions" | "memory";

interface AppShellProps {
  view: View;
  lastUpdated: Date | null;
  onViewChange: (view: View) => void;
  onRefresh: () => void;
  children: ReactNode;
}

export function AppShell({ view, lastUpdated, onViewChange, onRefresh, children }: AppShellProps) {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            ◒
          </span>
          <h1 className="eyebrow">KLEIN OBSERVATORY</h1>
        </div>
        <div className="header-status">
          <span className="status-dot" aria-hidden="true" />
          <Text size="xs">ローカル接続</Text>
          {lastUpdated && (
            <time dateTime={lastUpdated.toISOString()}>
              更新 {formatTimestamp(lastUpdated.toISOString())}
            </time>
          )}
          <ActionIcon
            aria-label="再読み込み"
            variant="light"
            color="teal"
            onClick={onRefresh}
            type="button"
          >
            ↻
          </ActionIcon>
        </div>
      </header>

      <SegmentedControl
        className="view-tabs"
        aria-label="表示切り替え"
        value={view}
        onChange={(value) => onViewChange(value as View)}
        data={[
          { value: "logs", label: "▤ ログ" },
          { value: "sessions", label: "◌ Piセッション" },
          { value: "memory", label: "▣ メモリ" },
        ]}
      />

      <main>{children}</main>

      <footer className="app-footer">Klein / local viewer</footer>
    </div>
  );
}
