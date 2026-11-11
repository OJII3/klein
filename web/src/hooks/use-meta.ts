import { useEffect, useState } from "preact/hooks";

import { getMeta } from "../api";

const DEFAULT_DISPLAY_NAME = "Klein";

/** Loads the running profile's display name and keeps the document title in sync. */
export function useDisplayName(): string {
  const [displayName, setDisplayName] = useState(DEFAULT_DISPLAY_NAME);

  useEffect(() => {
    let current = true;
    void getMeta()
      .then((meta) => {
        if (current) setDisplayName(meta.displayName);
      })
      .catch(() => {
        // The default name matches the static document title.
      });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    document.title = displayName;
  }, [displayName]);

  return displayName;
}
