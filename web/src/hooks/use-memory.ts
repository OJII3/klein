import { useCallback, useEffect, useState } from "react";

import {
  deleteMemory,
  addMemoryRule,
  getMemory,
  listMemoryScopes,
  type MemoryEntry,
  memoryScopeKey,
  parseMemoryScopeKey,
  type MemoryScope,
  type MemoryScopeSummary,
} from "../api";

interface UseMemoryOptions {
  active: boolean;
  onUpdated: () => void;
  initialScopeKey: string | null;
}

export function useMemory({ active, onUpdated, initialScopeKey }: UseMemoryOptions) {
  const [enabled, setEnabled] = useState(false);
  const [scopes, setScopes] = useState<MemoryScopeSummary[]>([]);
  const [scopesLoading, setScopesLoading] = useState(false);
  const [scopesError, setScopesError] = useState<string | null>(null);
  const [selectedScope, setSelectedScope] = useState<MemoryScope | null>(() =>
    parseMemoryScopeKey(initialScopeKey),
  );
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailReloadKey, setDetailReloadKey] = useState(0);
  const [deletingEntryId, setDeletingEntryId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [addRuleError, setAddRuleError] = useState<string | null>(null);
  const [addingRule, setAddingRule] = useState(false);

  const load = useCallback(async () => {
    setScopesLoading(true);
    setScopesError(null);

    try {
      const response = await listMemoryScopes();
      setEnabled(response.enabled);
      setScopes(response.items);
      setSelectedScope((current) => {
        const currentKey = current ? memoryScopeKey(current) : null;
        return (
          response.items.find((item) => memoryScopeKey(item.scope) === currentKey)?.scope ??
          response.items[0]?.scope ??
          null
        );
      });
      if (response.items.length === 0) setEntries([]);
      onUpdated();
    } catch (requestError) {
      setScopesError(
        requestError instanceof Error ? requestError.message : "メモリ一覧の取得に失敗しました",
      );
    } finally {
      setScopesLoading(false);
    }
  }, [onUpdated]);

  useEffect(() => {
    if (!active) return;

    void load();
    const timer = window.setInterval(load, 10000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  useEffect(() => {
    if (!active || !selectedScope) return;

    let current = true;
    setDetailLoading(true);
    setDetailError(null);

    void getMemory(selectedScope)
      .then((response) => {
        if (!current) return;
        setEntries(response.entries);
      })
      .catch((requestError: unknown) => {
        if (!current) return;
        setDetailError(
          requestError instanceof Error ? requestError.message : "メモリの取得に失敗しました",
        );
      })
      .finally(() => {
        if (current) setDetailLoading(false);
      });

    return () => {
      current = false;
    };
  }, [active, detailReloadKey, selectedScope]);

  const retryDetail = useCallback(() => {
    setDetailReloadKey((key) => key + 1);
  }, []);

  const selectScope = useCallback((scope: MemoryScope) => {
    setSelectedScope(scope);
    setDeleteError(null);
  }, []);

  const dismissDeleteError = useCallback(() => {
    setDeleteError(null);
  }, []);

  const createRule = useCallback(
    async (title: string, content: string) => {
      if (!selectedScope || addingRule) return;
      setAddingRule(true);
      setAddRuleError(null);
      try {
        await addMemoryRule(selectedScope, { title, content });
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
    [addingRule, load, selectedScope],
  );

  const deleteEntry = useCallback(
    async (entryId: string) => {
      if (!selectedScope || deletingEntryId) return;

      setDeletingEntryId(entryId);
      setDeleteError(null);
      try {
        await deleteMemory(selectedScope, entryId);
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
    [deletingEntryId, load, selectedScope],
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
    selectedScope,
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
    selectScope,
    reload,
    retryDetail,
  };
}
