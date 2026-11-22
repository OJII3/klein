import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import { getProactivity, type ProactivityReport } from "../api";

interface UseProactivityOptions {
  active: boolean;
  onUpdated: () => void;
}

export function useProactivity({ active, onUpdated }: UseProactivityOptions) {
  const [report, setReport] = useState<ProactivityReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const load = useCallback(async () => {
    if (!loadedRef.current) setLoading(true);
    setError(null);

    try {
      const response = await getProactivity();
      setReport(response);
      onUpdated();
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "自発の状態を取得できませんでした",
      );
    } finally {
      loadedRef.current = true;
      setLoading(false);
    }
  }, [onUpdated]);

  useEffect(() => {
    if (!active) return undefined;

    void load();
    const timer = window.setInterval(() => void load(), 10000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  return {
    report,
    loading,
    error,
    reload: load,
  };
}
