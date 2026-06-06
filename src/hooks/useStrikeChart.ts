import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { StrikeSymbol, StrikeChartResponse } from "@/lib/strikeChartTypes";

interface UseOptions {
  symbol: StrikeSymbol;
  date?: string | null;
  offset?: number;
  interval?: string;
  intervalMs?: number;
  enabled?: boolean;
  include50?: boolean;
}

export function useStrikeChart({
  symbol,
  date,
  offset = 3,
  interval = "5",
  intervalMs = 0,
  enabled = true,
  include50 = false,
}: UseOptions) {
  const [data, setData] = useState<StrikeChartResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchAt, setLastFetchAt] = useState<number | null>(null);
  const inFlight = useRef(false);

  const fetchOnce = async () => {
    if (inFlight.current || !enabled) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const params: Record<string, string> = {
        symbol,
        offset: String(offset),
        interval,
      };
      if (date) params.date = date;
      if (include50) params.include50 = "1";
      const res = await api.get<StrikeChartResponse>("/api/strike-chart", { params, timeout: 20000 });
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
        if (intervalMs > 0) timer = setTimeout(tick, intervalMs);
        return;
      }
      await fetchOnce();
      if (cancelled) return;
      if (date) return;          // historical → fetch once
      if (!(intervalMs > 0)) return; // polling disabled
      timer = setTimeout(tick, intervalMs);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, date, offset, interval, intervalMs, enabled, include50]);

  return { data, loading, error, lastFetchAt, refetch: fetchOnce };
}
