import { useCallback, useEffect, useState } from "react";

import { AppShell, type View } from "./components/app-shell";
import { useLogs } from "./hooks/use-logs";
import { useSessions } from "./hooks/use-sessions";
import { useMemory } from "./hooks/use-memory";
import { LogsView } from "./features/logs/logs-view";
import { MemoryView } from "./features/memory/memory-view";
import { SessionsView } from "./features/sessions/sessions-view";

export default function App() {
  const [view, setView] = useState<View>(() => viewFromPath(window.location.pathname));
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const onUpdated = useCallback(() => setLastUpdated(new Date()), []);
  const changeView = useCallback((nextView: View) => {
    window.history.pushState(null, "", `/${nextView}`);
    setView(nextView);
  }, []);
  useEffect(() => {
    const syncView = () => {
      const nextView = viewFromPath(window.location.pathname);
      setView(nextView);
      if (window.location.pathname !== `/${nextView}`) {
        window.history.replaceState(null, "", `/${nextView}`);
      }
    };
    window.addEventListener("popstate", syncView);
    syncView();
    return () => window.removeEventListener("popstate", syncView);
  }, []);
  const logs = useLogs({ active: view === "logs", onUpdated });
  const sessions = useSessions({ active: view === "sessions", onUpdated });
  const memory = useMemory({ active: view === "memory", onUpdated });

  const refreshCurrentView = useCallback(() => {
    if (view === "logs") logs.reload();
    else if (view === "sessions") void sessions.reload();
    else void memory.reload();
  }, [logs.reload, memory.reload, sessions.reload, view]);

  return (
    <AppShell
      lastUpdated={lastUpdated}
      onRefresh={refreshCurrentView}
      onViewChange={changeView}
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
      ) : view === "sessions" ? (
        <SessionsView
          detailError={sessions.detailError}
          error={sessions.sessionsError}
          events={sessions.events}
          loading={sessions.sessionsLoading}
          loadingMoreSessions={sessions.sessionsLoadingMore}
          loadingDetail={sessions.detailLoading}
          loadingMoreDetail={sessions.detailLoadingMore}
          nextCursor={sessions.nextCursor}
          onLoadMoreSessions={sessions.loadMoreSessions}
          onRetry={() => void sessions.reload()}
          onLoadMoreDetail={sessions.loadMoreDetail}
          onRetryDetail={sessions.retryDetail}
          onSelect={sessions.selectSession}
          selectedSession={sessions.selectedSession}
          sessionsNextCursor={sessions.sessionsNextCursor}
          sessions={sessions.sessions}
        />
      ) : (
        <MemoryView
          detailError={memory.detailError}
          deleteError={memory.deleteError}
          deletingEntryId={memory.deletingEntryId}
          addingRule={memory.addingRule}
          addRuleError={memory.addRuleError}
          enabled={memory.enabled}
          entries={memory.entries}
          error={memory.guildsError}
          guilds={memory.guilds}
          loading={memory.guildsLoading}
          loadingDetail={memory.detailLoading}
          onDelete={memory.deleteEntry}
          onAddRule={memory.createRule}
          onDismissDeleteError={memory.dismissDeleteError}
          onRetry={() => void memory.reload()}
          onRetryDetail={memory.retryDetail}
          onSelect={memory.selectGuild}
          selectedGuildId={memory.selectedGuildId}
        />
      )}
    </AppShell>
  );
}

function viewFromPath(pathname: string): View {
  const segment = pathname.split("/").filter(Boolean)[0];
  return segment === "sessions" || segment === "memory" ? segment : "logs";
}
