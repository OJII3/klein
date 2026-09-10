import { useCallback, useState } from "react";

import { AppShell, type View } from "./components/app-shell.js";
import { useLogs } from "./hooks/use-logs.js";
import { useSessions } from "./hooks/use-sessions.js";
import { LogsView } from "./features/logs/logs-view.js";
import { SessionsView } from "./features/sessions/sessions-view.js";

export default function App() {
  const [view, setView] = useState<View>("logs");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const onUpdated = useCallback(() => setLastUpdated(new Date()), []);
  const logs = useLogs({ active: view === "logs", onUpdated });
  const sessions = useSessions({ active: view === "sessions", onUpdated });

  const refreshCurrentView = useCallback(() => {
    if (view === "logs") logs.reload();
    else void sessions.reload();
  }, [logs.reload, sessions.reload, view]);

  return (
    <AppShell
      lastUpdated={lastUpdated}
      onRefresh={refreshCurrentView}
      onViewChange={setView}
      view={view}
    >
      {view === "logs" ? (
        <LogsView
          error={logs.error}
          filters={logs.filters}
          loading={logs.loading}
          loadingMore={logs.loadingMore}
          logs={logs.logs}
          nextCursor={logs.nextCursor}
          onFilter={logs.setFilters}
          onLoadMore={logs.loadMore}
          onRetry={logs.reload}
        />
      ) : (
        <SessionsView
          detailError={sessions.detailError}
          error={sessions.sessionsError}
          events={sessions.events}
          loading={sessions.sessionsLoading}
          loadingDetail={sessions.detailLoading}
          onRetry={() => void sessions.reload()}
          onRetryDetail={sessions.retryDetail}
          onSelect={sessions.selectSession}
          selectedSession={sessions.selectedSession}
          sessions={sessions.sessions}
        />
      )}
    </AppShell>
  );
}
