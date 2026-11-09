import { useCallback, useState } from "preact/hooks";

import { AppShell } from "./components/app-shell";
import { useLogs } from "./hooks/use-logs";
import { useSessions } from "./hooks/use-sessions";
import { useMemory } from "./hooks/use-memory";
import { useToolUsage } from "./hooks/use-tool-usage";
import { LogsView } from "./features/logs/logs-view";
import { MemoryView } from "./features/memory/memory-view";
import { SessionsView } from "./features/sessions/sessions-view";
import { ToolsView } from "./features/tools/tools-view";
import { memoryScopeKey, type MemoryScope } from "./api";
import { navigate, useRoute } from "./router";

export default function App() {
  const route = useRoute();
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const onUpdated = useCallback(() => setLastUpdated(new Date()), []);

  const logs = useLogs({ active: route.view === "logs", onUpdated });
  const sessions = useSessions({
    active: route.view === "sessions",
    onUpdated,
    selectedSessionId: route.view === "sessions" ? route.sessionId : null,
  });
  const memory = useMemory({
    active: route.view === "memory",
    onUpdated,
    selectedScopeKey: route.view === "memory" ? route.scopeKey : null,
  });
  const toolUsage = useToolUsage({ active: route.view === "tools", onUpdated });

  const selectSession = useCallback((sessionId: string) => {
    navigate(`/sessions?session=${encodeURIComponent(sessionId)}`);
  }, []);
  const selectScope = useCallback((scope: MemoryScope) => {
    navigate(`/memory?scope=${encodeURIComponent(memoryScopeKey(scope))}`);
  }, []);

  const refreshCurrentView = useCallback(() => {
    if (route.view === "logs") logs.reload();
    else if (route.view === "sessions") void sessions.reload();
    else if (route.view === "tools") void toolUsage.reload();
    else void memory.reload();
  }, [logs.reload, memory.reload, sessions.reload, toolUsage.reload, route.view]);

  return (
    <AppShell lastUpdated={lastUpdated} onRefresh={refreshCurrentView} view={route.view}>
      {route.view === "logs" ? (
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
      ) : route.view === "sessions" ? (
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
          onSelect={selectSession}
          selectedSession={sessions.selectedSession}
          sessionsNextCursor={sessions.sessionsNextCursor}
          sessions={sessions.sessions}
        />
      ) : route.view === "tools" ? (
        <ToolsView
          error={toolUsage.error}
          loading={toolUsage.loading}
          onRetry={() => void toolUsage.reload()}
          report={toolUsage.report}
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
          error={memory.scopesError}
          scopes={memory.scopes}
          loading={memory.scopesLoading}
          loadingDetail={memory.detailLoading}
          onDelete={memory.deleteEntry}
          onAddRule={memory.createRule}
          onDismissDeleteError={memory.dismissDeleteError}
          onRetry={() => void memory.reload()}
          onRetryDetail={memory.retryDetail}
          onSelect={selectScope}
          selectedScope={memory.selectedScope}
        />
      )}
    </AppShell>
  );
}
