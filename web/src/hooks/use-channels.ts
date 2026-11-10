import { useEffect, useState } from "preact/hooks";

import { listChannels } from "../api";

/** Loads the persisted Discord channel name mapping. */
export function useChannels(active: boolean): ReadonlyMap<string, string> {
  const [channelNames, setChannelNames] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    if (!active) return;

    let current = true;
    void listChannels()
      .then((response) => {
        if (!current) return;
        setChannelNames(new Map(response.items.map((item) => [item.channelId, item.name])));
      })
      .catch(() => {
        // Channel names only label other data, so a failure keeps the raw ids.
      });

    return () => {
      current = false;
    };
  }, [active]);

  return channelNames;
}
