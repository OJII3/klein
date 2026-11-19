import { useCallback, useState } from "preact/hooks";

import { AppShell } from "./components/app-shell";
import { useChannels } from "./hooks/use-channels";
import { useDisplayName } from "./hooks/use-meta";
import { useLogs } from "./hooks/use-logs";
import { useSessions } from "./hooks/use-sessions";
import { useMemory } from "./hooks/use-memory";
import { useToolUsage } from "./hooks/use-tool-usage";
import { LogsView } from "./features/logs/logs-view";
import { MemoryView } from "./features/memory/memory-view";
import { SessionsView } from "./features/sessions/sessions-view";
import { ToolsView } from "./features/tools/tools-view";
import { memoryScopeKey, type MemorySelection } from "./api";
import { navigate, useRoute } from "./router";

export default function App() {
  const route = useRoute();
  const displayName = useDisplayName();
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
  const channelNames = useChannels(route.view === "memory");

  const selectSession = useCallback((sessionId: string) => {
    navigate(`/sessions?session=${encodeURIComponent(sessionId)}`);
  }, []);
  const selectScope = useCallback((scope: MemorySelection) => {
    navigate(`/memory?scope=${encodeURIComponent(memoryScopeKey(scope))}`);
  }, []);

  const { reload: reloadLogs } = logs;
  const { reload: reloadSessions } = sessions;
  const { reload: reloadMemory } = memory;
  const { reload: reloadToolUsage } = toolUsage;

  const refreshCurrentView = useCallback(() => {
    if (route.view === "logs") reloadLogs();
    else if (route.view === "sessions") void reloadSessions();
    else if (route.view === "tools") void reloadToolUsage();
    else reloadMemory();
  }, [reloadLogs, reloadMemory, reloadSessions, reloadToolUsage, route.view]);

  return (
    <AppShell
      displayName={displayName}
      lastUpdated={lastUpdated}
      onRefresh={refreshCurrentView}
      view={route.view}
    >
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
          channelNames={channelNames}
          detailError={memory.detailError}
          deletingFileKey={memory.deletingFileKey}
          deletingUserMemory={memory.deletingUserMemory}
          enabled={memory.enabled}
          error={memory.scopesError}
          fileError={memory.fileError}
          guildMemory={memory.guildMemory}
          loading={memory.scopesLoading}
          loadingDetail={memory.detailLoading}
          onDeleteFile={memory.deleteFile}
          onDeleteUserMemory={(userId) => {
            void memory.deleteUser(userId);
          }}
          onDismissFileError={memory.dismissFileError}
          onRetry={memory.reload}
          onRetryDetail={memory.retryDetail}
          onSaveFile={memory.saveFile}
          onSelect={selectScope}
          savingFileKey={memory.savingFileKey}
          scopes={memory.scopes}
          selectedScope={memory.selectedScope}
          userMemory={memory.userMemory}
          userMemoryEnabled={memory.userMemoryEnabled}
          users={memory.users}
        />
      )}
    </AppShell>
  );
}
