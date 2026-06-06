import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { CCSymbol, CprCamResponse } from "@/lib/cprCamTypes";

interface UseOptions {
  symbol: CCSymbol;
  date?: string | null;
  intervalMs?: number;
  enabled?: boolean;
  interval?: string;
}

export function useCprCam({
  symbol,
  date,
  intervalMs = 3000,
  enabled = true,
  interval = "5",
}: UseOptions) {
  const [data, setData] = useState<CprCamResponse | null>(null);
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
      if (interval) params.interval = String(interval);
      const res = await api.get<CprCamResponse>("/api/cpr-cam", { params, timeout: 12000 });
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
      if (date) return;
      if (!(intervalMs > 0)) return;
      timer = setTimeout(tick, intervalMs);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, date, intervalMs, enabled, interval]);

  return { data, loading, error, lastFetchAt, refetch: fetchOnce };
}
