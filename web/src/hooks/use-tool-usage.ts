import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import { getToolUsage, type ToolUsageReport } from "../api";

interface UseToolUsageOptions {
  active: boolean;
  onUpdated: () => void;
}

export function useToolUsage({ active, onUpdated }: UseToolUsageOptions) {
  const [report, setReport] = useState<ToolUsageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const load = useCallback(async () => {
    if (!loadedRef.current) setLoading(true);
    setError(null);

    try {
      const response = await getToolUsage();
      setReport(response);
      loadedRef.current = true;
      onUpdated();
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "ツール使用状況の取得に失敗しました",
      );
    } finally {
      setLoading(false);
    }
  }, [onUpdated]);

  useEffect(() => {
    if (!active) return;

    void load();
    const timer = window.setInterval(() => void load(), 10000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  return { error, loading, reload: load, report };
}
