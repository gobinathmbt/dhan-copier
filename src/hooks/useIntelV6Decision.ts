import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { V6Decision, V6Symbol } from "@/lib/intelV6Types";

interface UseV6Options {
  symbol: V6Symbol;
  date?: string | null;
  intervalMs?: number;
  enabled?: boolean;
}

export function useIntelV6Decision({
  symbol,
  date,
  intervalMs = 3000,
  enabled = true,
}: UseV6Options) {
  const [data, setData] = useState<V6Decision | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchAt, setLastFetchAt] = useState<number | null>(null);
  const inFlight = useRef(false);

  const fetchOnce = async () => {
    if (inFlight.current || !enabled) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const params: Record<string, string> = { symbol };
      if (date) params.date = date;
      const res = await api.get<V6Decision>("/api/intel-v6/decision", { params, timeout: 12000 });
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
        timer = setTimeout(tick, intervalMs);
        return;
      }
      await fetchOnce();
      if (cancelled) return;
      if (date) return;
      timer = setTimeout(tick, intervalMs);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, date, intervalMs, enabled]);

  return { data, loading, error, lastFetchAt, refetch: fetchOnce };
}
