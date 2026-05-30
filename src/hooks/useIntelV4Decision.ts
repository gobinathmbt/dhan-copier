import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { V4Decision, V4Symbol } from "@/lib/intelV4Types";

interface UseV4Options {
  symbol: V4Symbol;
  date?: string | null;
  intervalMs?: number;
  enabled?: boolean;
}

interface UseV4Result {
  data: V4Decision | null;
  loading: boolean;
  error: string | null;
  lastFetchAt: number | null;
  refetch: () => Promise<void>;
}

/** Poll /api/intel-v4/decision. Same lifecycle pattern as the V2 hook. */
export function useIntelV4Decision({
  symbol,
  date,
  intervalMs = 3000,
  enabled = true,
}: UseV4Options): UseV4Result {
  const [data, setData] = useState<V4Decision | null>(null);
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
      const res = await api.get<V4Decision>("/api/intel-v4/decision", { params, timeout: 12000 });
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
      if (date) return; // historical → fetch once
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
