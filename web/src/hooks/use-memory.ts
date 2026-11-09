import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import {
  deleteMemory,
  addMemoryRule,
  getMemory,
  listMemoryScopes,
  type MemoryEntry,
  memoryScopeKey,
  parseMemoryScopeKey,
  type MemoryScopeSummary,
} from "../api";

interface UseMemoryOptions {
  active: boolean;
  onUpdated: () => void;
  selectedScopeKey: string | null;
}

export function useMemory({ active, onUpdated, selectedScopeKey }: UseMemoryOptions) {
  const [enabled, setEnabled] = useState(false);
  const [scopes, setScopes] = useState<MemoryScopeSummary[]>([]);
  const [scopesLoading, setScopesLoading] = useState(false);
  const [scopesError, setScopesError] = useState<string | null>(null);
  const selectedScope = useMemo(() => parseMemoryScopeKey(selectedScopeKey), [selectedScopeKey]);
  const effectiveScope = useMemo(() => {
    if (selectedScope) {
      if (scopes.length === 0) return selectedScope;
      const key = memoryScopeKey(selectedScope);
      if (scopes.some((item) => memoryScopeKey(item.scope) === key)) return selectedScope;
    }
    return scopes[0]?.scope ?? null;
  }, [scopes, selectedScope]);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
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
      setScopes(response.items);
      if (response.items.length === 0) setEntries([]);
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

    void getMemory(effectiveScope)
      .then((response) => {
        if (!current) return;
        detailScopeKeyRef.current = scopeKey;
        setEntries(response.entries);
      })
      .catch((requestError: unknown) => {
        if (!current) return;
        setDetailError(
          requestError instanceof Error ? requestError.message : "メモリの取得に失敗しました",
        );
      })
      .finally(() => {
        if (current && !silent) setDetailLoading(false);
      });

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
      if (!effectiveScope || addingRule) return;
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
      if (!effectiveScope || deletingEntryId) return;

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
    scopes,
    scopesLoading,
    scopesError,
    selectedScope: effectiveScope,
    entries,
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
