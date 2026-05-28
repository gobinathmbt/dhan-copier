import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { IntelV3Snapshot, IntelV3Symbol } from "@/lib/intelV3Types";

interface UseIntelV3Options {
  symbol: IntelV3Symbol;
  date?: string | null;
  intervalMs?: number;
  enabled?: boolean;
}

interface UseIntelV3Result {
  data: IntelV3Snapshot | null;
  loading: boolean;
  error: string | null;
  lastFetchAt: number | null;
  refetch: () => Promise<void>;
}

/** Polls /api/intel-v3/snapshot. Live mode polls every 3s, historical fetches once. */
export function useIntelV3Snapshot({
  symbol, date, intervalMs = 3000, enabled = true,
}: UseIntelV3Options): UseIntelV3Result {
  const [data, setData] = useState<IntelV3Snapshot | null>(null);
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
      const res = await api.get<IntelV3Snapshot>(`/api/intel-v3/snapshot`, { params, timeout: 12000 });
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
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, date, intervalMs, enabled]);

  return { data, loading, error, lastFetchAt, refetch: fetchOnce };
}

export async function fetchAvailableDatesV3(symbol: IntelV3Symbol): Promise<string[]> {
  try {
    const res = await api.get<{ ok: boolean; dates: string[] }>(`/api/intel-v3/available-dates`, {
      params: { symbol }, timeout: 8000,
    });
    return res.data?.dates || [];
  } catch (_) {
    return [];
  }
}
