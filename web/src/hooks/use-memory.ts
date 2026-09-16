import { useCallback, useEffect, useState } from "react";

import { getMemory, listMemoryGuilds, type MemoryEntry, type MemoryGuildSummary } from "../api";

interface UseMemoryOptions {
  active: boolean;
  onUpdated: () => void;
}

export function useMemory({ active, onUpdated }: UseMemoryOptions) {
  const [enabled, setEnabled] = useState(false);
  const [guilds, setGuilds] = useState<MemoryGuildSummary[]>([]);
  const [guildsLoading, setGuildsLoading] = useState(false);
  const [guildsError, setGuildsError] = useState<string | null>(null);
  const [selectedGuildId, setSelectedGuildId] = useState<string | null>(null);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailReloadKey, setDetailReloadKey] = useState(0);

  const load = useCallback(async () => {
    setGuildsLoading(true);
    setGuildsError(null);

    try {
      const response = await listMemoryGuilds();
      setEnabled(response.enabled);
      setGuilds(response.items);
      setSelectedGuildId((current) =>
        current && response.items.some((guild) => guild.guildId === current)
          ? current
          : (response.items[0]?.guildId ?? null),
      );
      if (response.items.length === 0) setEntries([]);
      onUpdated();
    } catch (requestError) {
      setGuildsError(
        requestError instanceof Error ? requestError.message : "メモリ一覧の取得に失敗しました",
      );
    } finally {
      setGuildsLoading(false);
    }
  }, [onUpdated]);

  useEffect(() => {
    if (!active) return;

    void load();
    const timer = window.setInterval(load, 10000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  useEffect(() => {
    if (!active || !selectedGuildId) return;

    let current = true;
    setDetailLoading(true);
    setDetailError(null);

    void getMemory(selectedGuildId)
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
  }, [active, detailReloadKey, selectedGuildId]);

  const retryDetail = useCallback(() => {
    setDetailReloadKey((key) => key + 1);
  }, []);

  const reload = useCallback(() => {
    void load();
    setDetailReloadKey((key) => key + 1);
  }, [load]);

  return {
    enabled,
    guilds,
    guildsLoading,
    guildsError,
    selectedGuildId,
    entries,
    detailLoading,
    detailError,
    selectGuild: setSelectedGuildId,
    reload,
    retryDetail,
  };
}
