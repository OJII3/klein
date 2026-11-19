import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import {
  deleteSharedMemoryFile,
  deleteUserMemory as requestDeleteUserMemory,
  getSharedMemory,
  getUserMemory,
  sharedMemoryScopeKey,
  listMemoryScopes,
  type SharedMemoryFile,
  type SharedMemoryScope,
  type MemorySelection,
  memoryScopeKey,
  parseMemoryScopeKey,
  type MemoryScopeSummary,
  saveSharedMemoryFile,
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
  const [scopes, setScopes] = useState<readonly MemoryScopeSummary[]>([]);
  const [users, setUsers] = useState<readonly UserMemorySummary[]>([]);
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
  const [sharedMemory, setSharedMemory] = useState<readonly SharedMemoryFile[] | null>(null);
  const [userMemory, setUserMemory] = useState<UserMemory | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailReloadKey, setDetailReloadKey] = useState(0);
  const [savingFileKey, setSavingFileKey] = useState<string | null>(null);
  const [deletingFileKey, setDeletingFileKey] = useState<string | null>(null);
  const [deletingUserMemory, setDeletingUserMemory] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
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
        setSharedMemory(null);
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
    if (!active) return undefined;

    void load();
    const timer = window.setInterval(() => {
      void load();
      setDetailReloadKey((key) => key + 1);
    }, 10000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  useEffect(() => {
    if (!active || !effectiveScope) return undefined;

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
          setSharedMemory(null);
          setUserMemory(response.memory);
        } else {
          const response = await getSharedMemory(effectiveScope.guildId);
          if (!current) return;
          setSharedMemory(response.files);
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
    setFileError(null);
  }, [effectiveScopeKey]);

  const retryDetail = useCallback(() => {
    setDetailReloadKey((key) => key + 1);
  }, []);

  const dismissFileError = useCallback(() => {
    setFileError(null);
  }, []);

  const saveFile = useCallback(
    async (scope: SharedMemoryScope, content: string): Promise<boolean> => {
      if (effectiveScope?.type !== "guild" || savingFileKey !== null) return false;
      const key = sharedMemoryScopeKey(scope);
      setSavingFileKey(key);
      setFileError(null);
      try {
        await saveSharedMemoryFile(effectiveScope.guildId, scope, content);
        setDetailReloadKey((value) => value + 1);
        void load();
        return true;
      } catch (requestError) {
        setFileError(
          requestError instanceof Error ? requestError.message : "メモリの保存に失敗しました",
        );
        return false;
      } finally {
        setSavingFileKey(null);
      }
    },
    [effectiveScope, load, savingFileKey],
  );

  const deleteFile = useCallback(
    async (scope: SharedMemoryScope): Promise<boolean> => {
      if (effectiveScope?.type !== "guild" || deletingFileKey !== null) return false;
      const key = sharedMemoryScopeKey(scope);
      setDeletingFileKey(key);
      setFileError(null);
      try {
        await deleteSharedMemoryFile(effectiveScope.guildId, scope);
        setSharedMemory((current) =>
          current ? current.filter((file) => sharedMemoryScopeKey(file.scope) !== key) : current,
        );
        void load();
        return true;
      } catch (requestError) {
        setFileError(
          requestError instanceof Error ? requestError.message : "メモリの削除に失敗しました",
        );
        return false;
      } finally {
        setDeletingFileKey(null);
      }
    },
    [deletingFileKey, effectiveScope, load],
  );

  const deleteUser = useCallback(
    async (userId: string) => {
      if (deletingUserMemory) return;

      setDeletingUserMemory(true);
      setFileError(null);
      try {
        await requestDeleteUserMemory(userId);
        setUsers((current) => current.filter((user) => user.userId !== userId));
        setUserMemory(null);
        setSharedMemory(null);
        void load();
      } catch (requestError) {
        setFileError(
          requestError instanceof Error
            ? requestError.message
            : "ユーザーメモリの削除に失敗しました",
        );
      } finally {
        setDeletingUserMemory(false);
      }
    },
    [deletingUserMemory, load],
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
    sharedMemory,
    userMemory,
    detailLoading,
    detailError,
    deleteFile,
    deleteUser,
    deletingFileKey,
    deletingUserMemory,
    saveFile,
    savingFileKey,
    fileError,
    dismissFileError,
    reload,
    retryDetail,
  };
}
