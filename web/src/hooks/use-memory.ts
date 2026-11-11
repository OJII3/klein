import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import {
  deleteMemory,
  addMemoryRule,
  getMemory,
  getUserMemory,
  listMemoryScopes,
  type MemoryEntry,
  type MemorySelection,
  memoryScopeKey,
  parseMemoryScopeKey,
  type MemoryScopeSummary,
  type UserMemory,
  type UserMemorySummary,
} from "../api";

interface UseMemoryOptions {
  active: boolean;
  onUpdated: () => void;
  selectedScopeKey: string | null;
}

export function useMemory({ active, onUpdated, selectedScopeKey }: UseMemoryOptions) {
  const [enabled, setEnabled] = useState(false);
  const [userMemoryEnabled, setUserMemoryEnabled] = useState(false);
  const [scopes, setScopes] = useState<MemoryScopeSummary[]>([]);
  const [users, setUsers] = useState<UserMemorySummary[]>([]);
  const [scopesLoading, setScopesLoading] = useState(false);
  const [scopesError, setScopesError] = useState<string | null>(null);
  const selectedScope = useMemo(() => parseMemoryScopeKey(selectedScopeKey), [selectedScopeKey]);
  const effectiveScope = useMemo<MemorySelection | null>(() => {
    if (selectedScope) {
      if (selectedScope.type === "user") {
        if (users.length === 0) return selectedScope;
        if (users.some((user) => user.userId === selectedScope.userId)) return selectedScope;
      } else if (scopes.length === 0) {
        return selectedScope;
      } else if (
        scopes.some((item) => memoryScopeKey(item.scope) === memoryScopeKey(selectedScope))
      ) {
        return selectedScope;
      }
    }
    const firstScope = scopes[0]?.scope;
    if (firstScope) return firstScope;
    const firstUser = users[0];
    return firstUser ? { type: "user", userId: firstUser.userId } : null;
  }, [scopes, selectedScope, users]);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [userMemory, setUserMemory] = useState<UserMemory | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailReloadKey, setDetailReloadKey] = useState(0);
  const [deletingEntryId, setDeletingEntryId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [addRuleError, setAddRuleError] = useState<string | null>(null);
  const [addingRule, setAddingRule] = useState(false);
  const scopesLoadedRef = useRef(false);
  const detailScopeKeyRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!scopesLoadedRef.current) setScopesLoading(true);
    setScopesError(null);

    try {
      const response = await listMemoryScopes();
      setEnabled(response.enabled);
      setUserMemoryEnabled(response.userMemoryEnabled);
      setScopes(response.items);
      setUsers(response.users);
      if (response.items.length === 0 && response.users.length === 0) {
        setEntries([]);
        setUserMemory(null);
      }
      onUpdated();
    } catch (requestError) {
      setScopesError(
        requestError instanceof Error ? requestError.message : "メモリ一覧の取得に失敗しました",
      );
    } finally {
      scopesLoadedRef.current = true;
      setScopesLoading(false);
    }
  }, [onUpdated]);

  useEffect(() => {
    if (!active) return;

    void load();
    const timer = window.setInterval(() => {
      void load();
      setDetailReloadKey((key) => key + 1);
    }, 10000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  useEffect(() => {
    if (!active || !effectiveScope) return;

    const scopeKey = memoryScopeKey(effectiveScope);
    const silent = detailScopeKeyRef.current === scopeKey;
    let current = true;
    if (!silent) setDetailLoading(true);
    setDetailError(null);

    void (async () => {
      try {
        if (effectiveScope.type === "user") {
          const response = await getUserMemory(effectiveScope.userId);
          if (!current) return;
          setEntries([]);
          setUserMemory(response.memory);
        } else {
          const response = await getMemory(effectiveScope);
          if (!current) return;
          setEntries(response.entries);
          setUserMemory(null);
        }
        detailScopeKeyRef.current = scopeKey;
      } catch (requestError) {
        if (!current) return;
        setDetailError(
          requestError instanceof Error ? requestError.message : "メモリの取得に失敗しました",
        );
      } finally {
        if (current && !silent) setDetailLoading(false);
      }
    })();

    return () => {
      current = false;
    };
  }, [active, detailReloadKey, effectiveScope]);

  const effectiveScopeKey = effectiveScope ? memoryScopeKey(effectiveScope) : null;
  useEffect(() => {
    setDeleteError(null);
  }, [effectiveScopeKey]);

  const retryDetail = useCallback(() => {
    setDetailReloadKey((key) => key + 1);
  }, []);

  const dismissDeleteError = useCallback(() => {
    setDeleteError(null);
  }, []);

  const createRule = useCallback(
    async (title: string, content: string) => {
      if (!effectiveScope || effectiveScope.type === "user" || addingRule) return;
      setAddingRule(true);
      setAddRuleError(null);
      try {
        await addMemoryRule(effectiveScope, { title, content });
        setDetailReloadKey((key) => key + 1);
        void load();
      } catch (requestError) {
        setAddRuleError(
          requestError instanceof Error ? requestError.message : "ルールの追加に失敗しました",
        );
      } finally {
        setAddingRule(false);
      }
    },
    [addingRule, effectiveScope, load],
  );

  const deleteEntry = useCallback(
    async (entryId: string) => {
      if (!effectiveScope || effectiveScope.type === "user" || deletingEntryId) return;

      setDeletingEntryId(entryId);
      setDeleteError(null);
      try {
        await deleteMemory(effectiveScope, entryId);
        setEntries((current) => current.filter((entry) => entry.id !== entryId));
        void load();
      } catch (requestError) {
        setDeleteError(
          requestError instanceof Error ? requestError.message : "メモリの削除に失敗しました",
        );
      } finally {
        setDeletingEntryId(null);
      }
    },
    [deletingEntryId, effectiveScope, load],
  );

  const reload = useCallback(() => {
    void load();
    setDetailReloadKey((key) => key + 1);
  }, [load]);

  return {
    enabled,
    userMemoryEnabled,
    scopes,
    users,
    scopesLoading,
    scopesError,
    selectedScope: effectiveScope,
    entries,
    userMemory,
    detailLoading,
    detailError,
    deleteEntry,
    createRule,
    addingRule,
    addRuleError,
    deleteError,
    deletingEntryId,
    dismissDeleteError,
    reload,
    retryDetail,
  };
}
