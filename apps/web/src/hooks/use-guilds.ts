import { useEffect, useState } from "preact/hooks";

import { listGuilds } from "../api";

export function useGuilds(active: boolean): ReadonlyMap<string, string> {
  const [guildNames, setGuildNames] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    if (!active) return undefined;

    let current = true;
    void (async () => {
      try {
        const response = await listGuilds();
        if (!current) return;
        setGuildNames(new Map(response.items.map((item) => [item.guildId, item.name])));
      } catch {
        // Guild names only label other data, so a failure keeps the raw ids.
      }
    })();

    return () => {
      current = false;
    };
  }, [active]);

  return guildNames;
}
