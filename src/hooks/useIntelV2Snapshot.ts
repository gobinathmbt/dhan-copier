import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { IntelV2Snapshot, IntelV2Symbol } from "@/lib/intelV2Types";

interface UseIntelV2Options {
  symbol: IntelV2Symbol;
  date?: string | null;     // null/undefined = live ("today")
  intervalMs?: number;
  enabled?: boolean;
}

interface UseIntelV2Result {
  data: IntelV2Snapshot | null;
  loading: boolean;
  error: string | null;
  lastFetchAt: number | null;
  refetch: () => Promise<void>;
}

/**
 * Polls /api/intel-v2/snapshot. When `date` is provided, fetches the
 * historical session for that date once (no auto-refresh) and pauses the
 * loop. Live mode keeps polling at intervalMs (default 2 s).
 */
export function useIntelV2Snapshot({
  symbol,
  date,
  intervalMs = 2000,
  enabled = true,
}: UseIntelV2Options): UseIntelV2Result {
  const [data, setData] = useState<IntelV2Snapshot | null>(null);
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
      const res = await api.get<IntelV2Snapshot>(`/api/intel-v2/snapshot`, {
        params,
        timeout: 12000,
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
        timer = setTimeout(tick, intervalMs);
        return;
      }
      await fetchOnce();
      // historical mode → fetch once, then stop the loop
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

/** Fetches the list of available historical dates for a symbol. */
export async function fetchAvailableDates(symbol: IntelV2Symbol): Promise<string[]> {
  try {
    const res = await api.get<{ ok: boolean; dates: string[] }>(`/api/intel-v2/available-dates`, {
      params: { symbol },
      timeout: 8000,
    });
    return res.data?.dates || [];
  } catch (_) {
    return [];
  }
}
