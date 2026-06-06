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
  const [showLines, setShowLines] = useState<boolean>(true);
  const [showMid, setShowMid] = useState<boolean>(false);
  const [showPrimary, setShowPrimary] = useState<boolean>(false);
  const [showOwn, setShowOwn] = useState<boolean>(false);
  const [include50, setInclude50] = useState<boolean>(false);
  // Live (no date) → poll every 2s. Historical → fetch once.
  const { data, loading, lastFetchAt, refetch } = useStrikeChart({
    symbol,
    date,
    offset,
    interval,
    intervalMs: date ? 0 : 2000,
    include50,
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
          <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[12px] text-white/75 hover:bg-white/[0.08]">
            <input
              type="checkbox"
              checked={showLines}
              onChange={(e) => setShowLines(e.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer accent-amber-400"
            />
            <span className="font-bold uppercase tracking-wider">
              Show Lines
            </span>
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[12px] text-white/75 hover:bg-white/[0.08]">
            <input
              type="checkbox"
              checked={showMid}
              disabled={!showLines}
              onChange={(e) => setShowMid(e.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer accent-orange-400 disabled:opacity-40"
            />
            <span className={`font-bold uppercase tracking-wider ${!showLines ? "text-white/30" : ""}`}>
              Show Mid
            </span>
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[12px] text-white/75 hover:bg-white/[0.08]">
            <input
              type="checkbox"
              checked={showPrimary}
              onChange={(e) => setShowPrimary(e.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer accent-blue-400"
            />
            <span className="font-bold uppercase tracking-wider">
              Primary Line
            </span>
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[12px] text-white/75 hover:bg-white/[0.08]">
            <input
              type="checkbox"
              checked={showOwn}
              onChange={(e) => setShowOwn(e.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer accent-emerald-400"
            />
            <span className="font-bold uppercase tracking-wider">
              Own 5 Min
            </span>
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[12px] text-white/75 hover:bg-white/[0.08]">
            <input
              type="checkbox"
              checked={include50}
              onChange={(e) => setInclude50(e.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer accent-amber-400"
            />
            <span className="font-bold uppercase tracking-wider">
              50 Strikes
            </span>
          </label>
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
          <ChartGrid
            data={data}
            showLines={showLines}
            showMid={showMid}
            showPrimary={showPrimary}
            showOwn={showOwn}
          />
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
function ChartGrid({
  data,
  showLines,
  showMid,
  showPrimary,
  showOwn,
}: {
  data: StrikeChartResponse;
  showLines: boolean;
  showMid: boolean;
  showPrimary: boolean;
  showOwn: boolean;
}) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-2">
      <LegChartCard
        side="CE"
        leg={data.primary.ce}
        otherLeg={data.primary.pe}
        markers={data.markers.ceChart}
        showLines={showLines}
        showMid={showMid}
        showPrimary={showPrimary}
        showOwn={showOwn}
      />
      <LegChartCard
        side="PE"
        leg={data.primary.pe}
        otherLeg={data.primary.ce}
        markers={data.markers.peChart}
        showLines={showLines}
        showMid={showMid}
        showPrimary={showPrimary}
        showOwn={showOwn}
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
  otherLeg,
  markers,
  showLines,
  showMid,
  showPrimary,
  showOwn,
}: {
  side: "CE" | "PE";
  leg: PrimaryLeg;
  otherLeg: PrimaryLeg;
  markers: ChartMarker[];
  showLines: boolean;
  showMid: boolean;
  showPrimary: boolean;
  showOwn: boolean;
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
          <span className={showLines ? "text-amber-300" : "text-white/30"}>
            {showLines ? `${markers.length} ${side === "CE" ? "PE" : "CE"} lines` : "lines off"}
          </span>
        </div>
      </div>
      <div className="min-h-[420px] flex-1">
        <CandleChart
          side={side}
          candles={leg.candles}
          markers={showLines ? markers : []}
          showMid={showLines && showMid}
          ownHigh={leg.firstFiveHigh}
          ownLow={leg.firstFiveLow}
          ownStrike={leg.strike}
          showOwn={showOwn}
          primaryHigh={otherLeg.firstFiveHigh}
          primaryLow={otherLeg.firstFiveLow}
          primaryStrike={otherLeg.strike}
          primarySide={side === "CE" ? "PE" : "CE"}
          showPrimary={showPrimary}
        />
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
  showMid,
  ownHigh,
  ownLow,
  ownStrike,
  showOwn,
  primaryHigh,
  primaryLow,
  primaryStrike,
  primarySide,
  showPrimary,
}: {
  side: "CE" | "PE";
  candles: ChartCandle[];
  markers: ChartMarker[];
  showMid: boolean;
  ownHigh: number;
  ownLow: number;
  ownStrike: number;
  showOwn: boolean;
  primaryHigh: number;
  primaryLow: number;
  primaryStrike: number;
  primarySide: "CE" | "PE";
  showPrimary: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);

  // Chart marker line color: CE chart → green, PE chart → red.
  const MARKER_COLOR = side === "CE" ? "#22c55e" : "#ef4444";
  const MARKER_WIDTH = 3;
  // Mid line: light orange dotted, drawn between consecutive marker prices.
  const MID_COLOR = "#fdba74"; // orange-300 (light orange)
  const MID_WIDTH = 1;
  // Primary cross-leg H/L: thick blue solid lines.
  const PRIMARY_COLOR = "#3b82f6"; // blue-500
  const PRIMARY_WIDTH = 3;
  // Own H/L: thick dotted, CE → green, PE → red.
  const OWN_COLOR = side === "CE" ? "#22c55e" : "#ef4444";
  const OWN_WIDTH = 3;

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
      lastCandleCountRef.current = 0;
    };
  }, [side]);

  // Push candles
  const lastCandleCountRef = useRef<number>(0);
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
    // Only auto-fit on first load (or major reset). Otherwise, preserve the
    // user's current zoom/scroll across the 2-second polling refreshes.
    if (data.length > 0 && lastCandleCountRef.current === 0) {
      chart.timeScale().fitContent();
    }
    lastCandleCountRef.current = data.length;
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
    // Mid lines: dotted light-orange, halfway between every pair of
    // consecutive marker prices (sorted by price ascending).
    if (showMid && markers && markers.length >= 2) {
      const prices = markers
        .filter((m) => m.price > 0)
        .map((m) => m.price)
        .sort((a, b) => a - b);
      for (let i = 0; i < prices.length - 1; i++) {
        const mid = (prices[i] + prices[i + 1]) / 2;
        const ln = series.createPriceLine({
          price: mid,
          color: MID_COLOR,
          lineWidth: MID_WIDTH as 1 | 2 | 3 | 4,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: `mid ${mid.toFixed(2)}`,
        });
        priceLinesRef.current.push(ln);
      }
    }
    // Primary cross-leg HIGH / LOW: thick BLUE solid lines drawn on this
    // chart at the OTHER leg's first-5-min H/L levels.
    if (showPrimary) {
      if (primaryHigh > 0) {
        const ln = series.createPriceLine({
          price: primaryHigh,
          color: PRIMARY_COLOR,
          lineWidth: PRIMARY_WIDTH as 1 | 2 | 3 | 4,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: `${primarySide} ${primaryStrike} 5m H`,
        });
        priceLinesRef.current.push(ln);
      }
      if (primaryLow > 0) {
        const ln = series.createPriceLine({
          price: primaryLow,
          color: PRIMARY_COLOR,
          lineWidth: PRIMARY_WIDTH as 1 | 2 | 3 | 4,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: `${primarySide} ${primaryStrike} 5m L`,
        });
        priceLinesRef.current.push(ln);
      }
    }
    // Own first-5-min H / L: thick DOTTED green (CE) or red (PE) lines.
    if (showOwn) {
      if (ownHigh > 0) {
        const ln = series.createPriceLine({
          price: ownHigh,
          color: OWN_COLOR,
          lineWidth: OWN_WIDTH as 1 | 2 | 3 | 4,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: `${side} ${ownStrike} 5m H`,
        });
        priceLinesRef.current.push(ln);
      }
      if (ownLow > 0) {
        const ln = series.createPriceLine({
          price: ownLow,
          color: OWN_COLOR,
          lineWidth: OWN_WIDTH as 1 | 2 | 3 | 4,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: `${side} ${ownStrike} 5m L`,
        });
        priceLinesRef.current.push(ln);
      }
    }
  }, [
    markers, MARKER_COLOR, MARKER_WIDTH,
    showMid, MID_COLOR, MID_WIDTH,
    showPrimary, primaryHigh, primaryLow, primaryStrike, primarySide, PRIMARY_COLOR, PRIMARY_WIDTH,
    showOwn, ownHigh, ownLow, ownStrike, OWN_COLOR, OWN_WIDTH, side,
  ]);

  return <div ref={containerRef} className="h-full w-full" />;
}
