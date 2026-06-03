import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  createChart,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  CrosshairMode,
  LineStyle,
} from "lightweight-charts";
import { isAuthenticated } from "@/lib/auth";
import { useStrikeChart } from "@/hooks/useStrikeChart";
import type {
  StrikeSymbol,
  StrikeChartResponse,
  PrimaryLeg,
  ChartMarker,
  ChartCandle,
} from "@/lib/strikeChartTypes";

export const Route = createFileRoute("/strike-chart")({
  component: StrikeChartPage,
});

/**
 * STRIKE CHART
 * ========================================================================
 * Two charts side-by-side for the day's PRIMARY (ATM) strike:
 *   • LEFT  — Primary CE candles + N×2 lines = PE first-5-min HIGH for
 *             every strike in [ATM-N, ATM+N] except ATM.
 *   • RIGHT — Primary PE candles + N×2 lines = CE first-5-min HIGH for
 *             every strike in [ATM-N, ATM+N] except ATM.
 * Source = live Dhan API when market is live, else the live-feed folder.
 */
function StrikeChartPage() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!isAuthenticated()) navigate({ to: "/login" });
  }, [navigate]);

  const [symbol, setSymbol] = useState<StrikeSymbol>("NIFTY_50");
  const [date, setDate] = useState<string | null>(null);
  const [offset, setOffset] = useState<number>(3);
  const [interval, setInterval] = useState<string>("5");
  const { data, loading, lastFetchAt, refetch } = useStrikeChart({
    symbol,
    date,
    offset,
    interval,
    intervalMs: 0, // fetch once + on control change; manual refresh still works
  });

  return (
    <div className="strike-chart-root fixed inset-0 left-3 flex flex-col bg-[#06090e] font-sans text-white">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#0a0e15] px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="text-[15px] font-bold tracking-[0.16em] text-amber-300">STRIKE CHART</span>
          <span className="text-[12px] uppercase tracking-[0.16em] text-white/50">
            ATM Primary · ± {offset} cross-leg lines
          </span>
          {data?.ok ? (
            <span
              className="rounded px-2 py-0.5 text-[10px] font-black uppercase tracking-wide"
              style={{
                background: data.source === "live" ? "#22c55e1a" : "#64748b1a",
                border: `1px solid ${data.source === "live" ? "#22c55e66" : "#64748b66"}`,
                color: data.source === "live" ? "#22c55e" : "#94a3b8",
              }}
            >
              {data.source === "live" ? "● LIVE" : "FOLDER"}
            </span>
          ) : null}
          {data?.ok ? (
            <span className="text-[11px] font-bold uppercase tracking-wider text-white/55">
              {data.displayName} · {data.date} · Spot {data.spot.toLocaleString()} · ATM {data.atm}
            </span>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md bg-white/[0.05] p-0.5">
            {(["NIFTY_50", "SENSEX"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSymbol(s)}
                className={`rounded px-3 py-1 text-[13px] font-bold tracking-wider transition-colors ${
                  symbol === s ? "bg-amber-500/20 text-amber-300" : "text-white/55 hover:text-white"
                }`}
              >
                {s === "NIFTY_50" ? "NIFTY" : "SENSEX"}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[12px] text-white/65">
            <span className="font-bold uppercase tracking-wider text-white/50">Strikes</span>
            <select
              value={offset}
              onChange={(e) => setOffset(Number(e.target.value))}
              className="bg-transparent text-[13px] font-bold text-amber-300 outline-none [color-scheme:dark]"
            >
              {[1, 2, 3, 4, 5, 6, 7, 8, 10].map((n) => (
                <option key={n} value={n} className="bg-[#0a0e15] text-white">
                  ± {n}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[12px] text-white/65">
            <span className="font-bold uppercase tracking-wider text-white/50">TF</span>
            <select
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
              className="bg-transparent text-[13px] font-bold text-amber-300 outline-none [color-scheme:dark]"
            >
              {["1", "5", "15", "30"].map((tf) => (
                <option key={tf} value={tf} className="bg-[#0a0e15] text-white">
                  {tf}m
                </option>
              ))}
            </select>
          </label>
          <input
            type="date"
            value={date || todayIST()}
            max={todayIST()}
            onChange={(e) => setDate(e.target.value === todayIST() ? null : e.target.value)}
            className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[13px] text-white/85 outline-none [color-scheme:dark]"
          />
          <button
            onClick={() => setDate(null)}
            className={`rounded px-2 py-1 text-[12px] font-bold tracking-wider ${
              !date ? "bg-emerald-500/20 text-emerald-400" : "bg-white/5 text-white/55"
            }`}
          >
            LIVE
          </button>
          <button
            onClick={() => refetch()}
            disabled={loading}
            className="rounded-md border border-white/10 bg-white/[0.04] px-3 py-1 text-[13px] text-white/65"
          >
            {loading ? "…" : "↻ Refresh"}
          </button>
          <span className="text-[11px] text-white/45">
            {lastFetchAt ? `${Math.round((Date.now() - lastFetchAt) / 1000)}s` : "—"}
          </span>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
        {!data ? (
          <div className="flex h-full items-center justify-center text-[16px] text-white/45">
            Loading strike chart…
          </div>
        ) : !data.ok ? (
          <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-6 text-rose-300">
            <div className="text-[15px] font-bold uppercase tracking-wider">Error</div>
            <div className="mt-2 text-[14px]">{data.error || "Unable to load strike chart."}</div>
          </div>
        ) : (
          <ChartGrid data={data} />
        )}
      </main>
    </div>
  );
}

function todayIST(): string {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
}

/* ═══════════════════════════════════════════════════════════════════════
 * CHART GRID — two charts side-by-side
 * ═══════════════════════════════════════════════════════════════════════ */
function ChartGrid({ data }: { data: StrikeChartResponse }) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-2">
      <LegChartCard
        side="CE"
        leg={data.primary.ce}
        markers={data.markers.ceChart}
      />
      <LegChartCard
        side="PE"
        leg={data.primary.pe}
        markers={data.markers.peChart}
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Single leg chart card
 * ═══════════════════════════════════════════════════════════════════════ */
function LegChartCard({
  side,
  leg,
  markers,
}: {
  side: "CE" | "PE";
  leg: PrimaryLeg;
  markers: ChartMarker[];
}) {
  const isCe = side === "CE";
  const borderColor = isCe ? "rgba(56,189,248,0.55)" : "rgba(244,63,94,0.55)";
  const bg = isCe ? "rgba(56,189,248,0.04)" : "rgba(244,63,94,0.04)";
  const titleClass = isCe ? "text-sky-300" : "text-rose-300";
  const ltpClass = isCe ? "text-sky-200" : "text-rose-200";

  return (
    <div
      className="flex min-h-0 flex-col rounded-xl border bg-[#0a0e15]"
      style={{ borderColor, background: bg }}
    >
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <div className="flex items-baseline gap-3">
          <span className={`text-[13px] font-black uppercase tracking-[0.16em] ${titleClass}`}>
            {side} · {leg.strike}
          </span>
          <span className="text-[11px] font-bold uppercase tracking-wider text-white/45">
            Primary
          </span>
          <span className={`font-mono text-[14px] font-black ${ltpClass}`}>
            LTP {leg.ltp.toFixed(2)}
          </span>
        </div>
        <div className="flex items-baseline gap-3 text-[11px] uppercase tracking-wider">
          <span className="text-emerald-300">5m H {fmt(leg.firstFiveHigh)}</span>
          <span className="text-rose-300">5m L {fmt(leg.firstFiveLow)}</span>
          <span className="text-amber-300">{markers.length} {side === "CE" ? "PE" : "CE"} lines</span>
        </div>
      </div>
      <div className="min-h-[420px] flex-1">
        <CandleChart side={side} candles={leg.candles} markers={markers} />
      </div>
    </div>
  );
}

function fmt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return "—";
  return Number(n).toFixed(2);
}

/* ═══════════════════════════════════════════════════════════════════════
 * CandleChart — candlestick + N horizontal price-line markers
 * ═══════════════════════════════════════════════════════════════════════ */
function CandleChart({
  side,
  candles,
  markers,
}: {
  side: "CE" | "PE";
  candles: ChartCandle[];
  markers: ChartMarker[];
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);

  // Chart marker line color: CE chart → green, PE chart → red.
  const MARKER_COLOR = side === "CE" ? "#22c55e" : "#ef4444";
  const MARKER_WIDTH = 3;

  // Init chart
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: "#0a0e15" },
        textColor: "rgba(226, 232, 240, 0.78)",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      timeScale: {
        borderColor: "rgba(255,255,255,0.08)",
        timeVisible: true,
        secondsVisible: false,
      },
      width: el.clientWidth,
      height: el.clientHeight || 420,
    });

    const series = chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#16a34a",
      borderDownColor: "#dc2626",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver(() => {
      if (!containerRef.current || !chartRef.current) return;
      chartRef.current.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      try { chart.remove(); } catch (_) { /* noop */ }
      chartRef.current = null;
      seriesRef.current = null;
      priceLinesRef.current = [];
    };
  }, [side]);

  // Push candles
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    const data = candles
      .filter((c) => c.time > 0)
      .map((c) => ({
        time: c.time as unknown as import("lightweight-charts").Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));
    series.setData(data);
    if (data.length > 0) chart.timeScale().fitContent();
  }, [candles]);

  // Draw / update marker price lines
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    // Remove previous lines
    for (const line of priceLinesRef.current) {
      try { series.removePriceLine(line); } catch (_) { /* noop */ }
    }
    priceLinesRef.current = [];
    // Add new ones
    for (const m of markers || []) {
      if (!(m.price > 0)) continue;
      const ln = series.createPriceLine({
        price: m.price,
        color: MARKER_COLOR,
        lineWidth: MARKER_WIDTH as 1 | 2 | 3 | 4,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: m.label,
      });
      priceLinesRef.current.push(ln);
    }
  }, [markers, MARKER_COLOR, MARKER_WIDTH]);

  return <div ref={containerRef} className="h-full w-full" />;
}
