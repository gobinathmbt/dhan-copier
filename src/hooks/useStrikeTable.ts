import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { StrikeSymbol, StrikeTableResponse } from "@/lib/strikeTableTypes";

interface UseOptions {
  symbol: StrikeSymbol;
  date?: string | null;
  range?: number;
  intervalMs?: number;
  enabled?: boolean;
}

export function useStrikeTable({
  symbol,
  date,
  range = 6,
  intervalMs = 3000,
  enabled = true,
}: UseOptions) {
  const [data, setData] = useState<StrikeTableResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchAt, setLastFetchAt] = useState<number | null>(null);
  const inFlight = useRef(false);

  const fetchOnce = async () => {
    if (inFlight.current || !enabled) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const params: Record<string, string> = { symbol, range: String(range) };
      if (date) params.date = date;
      const res = await api.get<StrikeTableResponse>("/api/strike-table", { params, timeout: 12000 });
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
      // Historical (date-pinned) → fetch once, no repeat polling.
      if (date) return;
      timer = setTimeout(tick, intervalMs);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, date, range, intervalMs, enabled]);

  return { data, loading, error, lastFetchAt, refetch: fetchOnce };
}
