import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import {
  getSession,
  listSessions,
  type PiSessionEvent,
  type SessionQuery,
  type SessionSummary,
} from "../api";

interface UseSessionsOptions {
  active: boolean;
  onUpdated: () => void;
  selectedSessionId: string | null;
}

export function useSessions({ active, onUpdated, selectedSessionId }: UseSessionsOptions) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionsNextCursor, setSessionsNextCursor] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<SessionSummary | null>(null);
  const [events, setEvents] = useState<PiSessionEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailLoadingMore, setDetailLoadingMore] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailReloadKey, setDetailReloadKey] = useState(0);
  const effectiveSessionId = selectedSessionId ?? sessions[0]?.id ?? null;
  const effectiveSessionIdRef = useRef<string | null>(null);
  effectiveSessionIdRef.current = effectiveSessionId;

  const load = useCallback(
    async (query: SessionQuery = {}, append = false) => {
      if (append) setSessionsLoadingMore(true);
      else setSessionsLoading(true);
      setSessionsError(null);

      try {
        const response = await listSessions(query);
        setSessions((current) => (append ? [...current, ...response.items] : response.items));
        setSessionsNextCursor(response.nextCursor);
        onUpdated();
      } catch (requestError) {
        setSessionsError(
          requestError instanceof Error ? requestError.message : "セッションの取得に失敗しました",
        );
      } finally {
        if (append) setSessionsLoadingMore(false);
        else setSessionsLoading(false);
      }
    },
    [onUpdated],
  );

  useEffect(() => {
    if (!active) return;

    void load();
    const timer = window.setInterval(load, 10000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  useEffect(() => {
    if (!active || !effectiveSessionId) return;

    let current = true;
    setDetailLoading(true);
    setDetailLoadingMore(false);
    setDetailError(null);
    setEvents([]);
    setNextCursor(null);

    void getSession(effectiveSessionId, { limit: 100 })
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
  }, [active, detailReloadKey, effectiveSessionId]);

  const retryDetail = useCallback(() => {
    setDetailReloadKey((key) => key + 1);
  }, []);

  const loadMoreSessions = useCallback(() => {
    if (!sessionsNextCursor || sessionsLoadingMore) return;
    void load({ cursor: sessionsNextCursor, limit: 100 }, true);
  }, [load, sessionsLoadingMore, sessionsNextCursor]);

  const loadMoreDetail = useCallback(() => {
    if (!effectiveSessionId || !nextCursor || detailLoadingMore) return;

    const requestedSessionId = effectiveSessionId;
    setDetailLoadingMore(true);
    setDetailError(null);
    void getSession(requestedSessionId, { cursor: nextCursor, limit: 100 })
      .then((response) => {
        if (effectiveSessionIdRef.current !== requestedSessionId) return;
        setEvents((current) => [...response.items, ...current]);
        setNextCursor(response.nextCursor);
      })
      .catch((requestError: unknown) => {
        if (effectiveSessionIdRef.current !== requestedSessionId) return;
        setDetailError(
          requestError instanceof Error ? requestError.message : "セッションの取得に失敗しました",
        );
      })
      .finally(() => {
        if (effectiveSessionIdRef.current === requestedSessionId) setDetailLoadingMore(false);
      });
  }, [detailLoadingMore, effectiveSessionId, nextCursor]);

  const selectedFromList =
    sessions.find((session) => session.id === effectiveSessionId) ??
    (selectedSession?.id === effectiveSessionId ? selectedSession : null);

  return {
    sessions,
    sessionsLoading,
    sessionsLoadingMore,
    sessionsError,
    sessionsNextCursor,
    selectedSessionId: effectiveSessionId,
    selectedSession: selectedFromList,
    events,
    nextCursor,
    detailLoading,
    detailLoadingMore,
    detailError,
    reload: load,
    retryDetail,
    loadMoreSessions,
    loadMoreDetail,
  };
}
