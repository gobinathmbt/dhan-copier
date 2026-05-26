import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { IntelSnapshot, SymbolKey } from "@/lib/intelTypes";

interface UseIntelOptions {
  intervalMs?: number;
  symbol: SymbolKey;
  enabled?: boolean;
}

interface UseIntelResult {
  data: IntelSnapshot | null;
  loading: boolean;
  error: string | null;
  lastFetchAt: number | null;
  refetch: () => Promise<void>;
}

/**
 * Polls /api/intel/snapshot at a fixed cadence (default 2s) and surfaces
 * the latest payload to the dashboard. Pauses fetches while the tab is
 * hidden to avoid wasting Dhan rate-limit budget.
 */
export function useIntelSnapshot({
  symbol,
  intervalMs = 2000,
  enabled = true,
}: UseIntelOptions): UseIntelResult {
  const [data, setData] = useState<IntelSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchAt, setLastFetchAt] = useState<number | null>(null);
  const inFlight = useRef(false);

  const fetchOnce = async () => {
    if (inFlight.current || !enabled) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const res = await api.get<IntelSnapshot>(`/api/intel/snapshot`, {
        params: { symbol },
        timeout: 8000,
      });
      setData(res.data);
      setLastFetchAt(Date.now());
      setError(null);
    } catch (e) {
      const err = e as { message?: string };
      setError(err.message || "fetch failed");
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  };

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) {
        // Skip fetch while tab is hidden, but keep cadence
        timer = setTimeout(tick, intervalMs);
        return;
      }
      await fetchOnce();
      if (cancelled) return;
      timer = setTimeout(tick, intervalMs);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, intervalMs, enabled]);

  return { data, loading, error, lastFetchAt, refetch: fetchOnce };
}
