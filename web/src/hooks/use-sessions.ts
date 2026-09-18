import { useCallback, useEffect, useRef, useState } from "react";

import { getSession, listSessions, type PiSessionEvent, type SessionSummary } from "../api";

interface UseSessionsOptions {
  active: boolean;
  onUpdated: () => void;
}

export function useSessions({ active, onUpdated }: UseSessionsOptions) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<SessionSummary | null>(null);
  const [events, setEvents] = useState<PiSessionEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailLoadingMore, setDetailLoadingMore] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailReloadKey, setDetailReloadKey] = useState(0);
  const selectedSessionIdRef = useRef<string | null>(null);
  selectedSessionIdRef.current = selectedSessionId;

  const load = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError(null);

    try {
      const response = await listSessions();
      setSessions(response.items);
      setSelectedSessionId((current) => current ?? response.items[0]?.id ?? null);
      onUpdated();
    } catch (requestError) {
      setSessionsError(
        requestError instanceof Error ? requestError.message : "セッションの取得に失敗しました",
      );
    } finally {
      setSessionsLoading(false);
    }
  }, [onUpdated]);

  useEffect(() => {
    if (!active) return;

    void load();
    const timer = window.setInterval(load, 10000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  useEffect(() => {
    if (!active || !selectedSessionId) return;

    let current = true;
    setDetailLoading(true);
    setDetailLoadingMore(false);
    setDetailError(null);
    setEvents([]);
    setNextCursor(null);

    void getSession(selectedSessionId, { limit: 100 })
      .then((response) => {
        if (!current) return;
        setSelectedSession(response.session);
        setEvents(response.items);
        setNextCursor(response.nextCursor);
      })
      .catch((requestError: unknown) => {
        if (!current) return;
        setDetailError(
          requestError instanceof Error ? requestError.message : "セッションの取得に失敗しました",
        );
      })
      .finally(() => {
        if (current) setDetailLoading(false);
      });

    return () => {
      current = false;
    };
  }, [active, detailReloadKey, selectedSessionId]);

  const retryDetail = useCallback(() => {
    setDetailReloadKey((key) => key + 1);
  }, []);

  const loadMoreDetail = useCallback(() => {
    if (!selectedSessionId || !nextCursor || detailLoadingMore) return;

    const requestedSessionId = selectedSessionId;
    setDetailLoadingMore(true);
    setDetailError(null);
    void getSession(requestedSessionId, { cursor: nextCursor, limit: 100 })
      .then((response) => {
        if (selectedSessionIdRef.current !== requestedSessionId) return;
        setEvents((current) => [...response.items, ...current]);
        setNextCursor(response.nextCursor);
      })
      .catch((requestError: unknown) => {
        if (selectedSessionIdRef.current !== requestedSessionId) return;
        setDetailError(
          requestError instanceof Error ? requestError.message : "セッションの取得に失敗しました",
        );
      })
      .finally(() => {
        if (selectedSessionIdRef.current === requestedSessionId) setDetailLoadingMore(false);
      });
  }, [detailLoadingMore, nextCursor, selectedSessionId]);

  const selectedFromList =
    sessions.find((session) => session.id === selectedSessionId) ?? selectedSession;

  return {
    sessions,
    sessionsLoading,
    sessionsError,
    selectedSessionId,
    selectedSession: selectedFromList ?? null,
    events,
    nextCursor,
    detailLoading,
    detailLoadingMore,
    detailError,
    selectSession: setSelectedSessionId,
    reload: load,
    retryDetail,
    loadMoreDetail,
  };
}
