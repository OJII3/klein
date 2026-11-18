import { useEffect, useState } from "preact/hooks";

import { listChannels } from "../api";

export function useChannels(active: boolean): ReadonlyMap<string, string> {
  const [channelNames, setChannelNames] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    if (!active) return undefined;

    let current = true;
    void (async () => {
      try {
        const response = await listChannels();
        if (!current) return;
        setChannelNames(new Map(response.items.map((item) => [item.channelId, item.name])));
      } catch {
        // Channel names only label other data, so a failure keeps the raw ids.
      }
    })();

    return () => {
      current = false;
    };
  }, [active]);

  return channelNames;
}
