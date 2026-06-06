import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
} from "lightweight-charts";
import { isAuthenticated } from "@/lib/auth";
import { useCprCam } from "@/hooks/useCprCam";
import type {
  CCSymbol, CprCamResponse, CCScenarioRow, CCDayTypeGuideRow,
} from "@/lib/cprCamTypes";

export const Route = createFileRoute("/cpr-cam")({
  component: CprCamPage,
});

/**
 * CPR + CAMARILLA POWER ENGINE — Option Buyer Combo Dashboard
 * ========================================================================
 * Layout exactly per the reference image:
 *   • Header strip: NIFTY / SENSEX + market-open + 6 stat cards
 *     (LTP / HIGH / LOW / CHANGE / VOLUME L / OI CHANGE / VWAP)
 *   • Main row: CPR LEVELS + CPR WIDTH | 5 MIN CHART | CAMARILLA LEVELS + MARKET BIAS
 *   • Bottom row: DAY TYPE GUIDE + KEY LEVELS SUMMARY | SCENARIO GUIDE | TRADE SETUP + CONFLUENCE CHECK
 *   • Footer tagline
 */
function CprCamPage() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!isAuthenticated()) navigate({ to: "/login" });
  }, [navigate]);

  const [symbol, setSymbol] = useState<CCSymbol>("NIFTY_50");
  const [date, setDate] = useState<string | null>(null);
  const [interval, setInterval] = useState<string>("5");
  const { data, loading, lastFetchAt, refetch } = useCprCam({
    symbol, date, interval, intervalMs: date ? 0 : 3000,
  });

  return (
    <div className="cprcam-root fixed inset-0 left-3 flex flex-col bg-black font-sans text-white">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#05070b] px-4 py-1.5">
        <div className="flex items-center gap-3">
          <span className="text-[14px] font-bold tracking-[0.18em] text-cyan-300">
            CPR + CAMARILLA <span className="rounded-sm bg-cyan-400/15 px-1.5 py-0.5 text-[11px]">POWER</span>
          </span>
          <span className="text-[11px] uppercase tracking-[0.16em] text-white/55">
            OPTION BUYER COMBO ENGINE
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md bg-white/[0.05] p-0.5">
            {(["NIFTY_50", "SENSEX"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSymbol(s)}
                className={`rounded px-3 py-1 text-[12px] font-bold tracking-wider transition-colors ${
                  symbol === s ? "bg-cyan-500/20 text-cyan-300" : "text-white/55 hover:text-white"
                }`}
              >
                {s === "NIFTY_50" ? "NIFTY" : "SENSEX"}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[12px] text-white/65">
            <span className="font-bold uppercase tracking-wider text-white/50">TF</span>
            <select
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
              className="bg-transparent text-[13px] font-bold text-cyan-300 outline-none [color-scheme:dark]"
            >
              {[
                { v: "1",  l: "1m" },
                { v: "3",  l: "3m" },
                { v: "5",  l: "5m" },
                { v: "15", l: "15m" },
                { v: "60", l: "1h" },
              ].map((tf) => (
                <option key={tf.v} value={tf.v} className="bg-[#0a0e15] text-white">{tf.l}</option>
              ))}
            </select>
          </label>
          <input
            type="date"
            value={date || todayIST()}
            max={todayIST()}
            onChange={(e) => setDate(e.target.value === todayIST() ? null : e.target.value)}
            className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[12px] text-white/85 outline-none [color-scheme:dark]"
          />
          <button
            onClick={() => setDate(null)}
            className={`rounded px-2 py-1 text-[11px] font-bold tracking-wider ${
              !date ? "bg-emerald-500/20 text-emerald-400" : "bg-white/5 text-white/55"
            }`}
          >LIVE</button>
          <button onClick={() => refetch()} disabled={loading}
            className="rounded-md border border-white/10 bg-white/[0.04] px-3 py-1 text-[12px] text-white/65">
            {loading ? "…" : "↻"}
          </button>
          <span className="text-[10px] text-white/45">
            {lastFetchAt ? `${Math.round((Date.now() - lastFetchAt) / 1000)}s` : "—"}
          </span>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
        {!data ? (
          <div className="flex h-full items-center justify-center text-[16px] text-white/45">
            Loading CPR + Camarilla Power Engine…
          </div>
        ) : !data.ok ? (
          <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-6 text-rose-300">
            <div className="text-[15px] font-bold uppercase tracking-wider">Engine Error</div>
            <div className="mt-2 text-[14px]">{data.error || "Unable to load CPR + Camarilla."}</div>
          </div>
        ) : (
          <Dashboard data={data} />
        )}
      </main>
    </div>
  );
}

function todayIST(): string {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
}

const TONE: Record<string, string> = {
  strongbull: "#16c784",
  bull: "#22c55e",
  neutral: "#eab308",
  bear: "#f97316",
  strongbear: "#ef4444",
};
function tc(t: string): string {
  return TONE[t] || (t === "BULLISH" ? "#22c55e" : t === "BEARISH" ? "#ef4444" : "#eab308");
}
function fmt2(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}
function fmtUp(n: number, sign = false): string {
  if (!Number.isFinite(n)) return "—";
  return `${sign && n >= 0 ? "+" : ""}${n.toFixed(2)}`;
}


/* ═════════════════════════════════════════════════════════════════════
 *  DASHBOARD — exact match for the reference image
 * ═════════════════════════════════════════════════════════════════════ */
function Dashboard({ data }: { data: CprCamResponse }) {
  return (
    <div className="flex flex-col gap-3">
      <HeaderStrip data={data} />

      {/* Main row — left panel (CPR), chart, right panel (Camarilla + Bias) */}
      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-3 flex min-w-0 flex-col gap-3">
          <CprLevelsCard data={data} />
          <CprWidthCard data={data} />
        </div>
        <div className="col-span-6 min-w-0"><ChartPanel data={data} /></div>
        <div className="col-span-3 flex min-w-0 flex-col gap-3">
          <CamLevelsCard data={data} />
          <MarketBiasCard data={data} />
        </div>
      </div>

      {/* Bottom row — guides + scenarios + trade setup */}
      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-3 flex min-w-0 flex-col gap-3">
          <DayTypeGuideCard data={data} />
          <KeyLevelsSummaryCard data={data} />
        </div>
        <div className="col-span-5 min-w-0"><ScenarioGuideCard data={data} /></div>
        <div className="col-span-4 flex min-w-0 flex-col gap-3">
          <TradeSetupCard data={data} />
          <ConfluenceCheckCard data={data} />
        </div>
      </div>

      <FooterStrip />
    </div>
  );
}

/* ═══════════════ HEADER STRIP (NIFTY + 6 stat cards) ════════════════ */
function HeaderStrip({ data }: { data: CprCamResponse }) {
  const ms = data.marketStats;
  const istMonths = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const ist = new Date(data.at + 5.5 * 3600 * 1000);
  const dateLabel = `${String(ist.getUTCDate()).padStart(2, "0")} ${istMonths[ist.getUTCMonth()]} ${ist.getUTCFullYear()}`;
  const chgTone = ms.change >= 0 ? "#22c55e" : "#ef4444";
  // Layout: symbol (3) + 7 stat cells (each spans ~1.28 cols → use a 14-col row)
  return (
    <div className="grid grid-cols-[3fr_1fr_1fr_1fr_1fr_1fr_1fr_1fr] items-stretch gap-2">
      {/* Symbol + market status */}
      <div className="flex min-w-0 flex-col justify-center rounded border border-white/10 bg-[#0a0f17] px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[26px] font-black uppercase tracking-wide text-white/95">
            {data.symbol === "SENSEX" ? "SENSEX" : "NIFTY 50"}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[11px] uppercase">
          <span className="text-white/55">{dateLabel}</span>
          <span className="flex items-center gap-1"
            style={{ color: ms.marketOpen ? "#22c55e" : "#94a3b8" }}>
            <span className="text-[10px]">●</span>
            {ms.marketLabel}
          </span>
        </div>
      </div>

      <StatCell label="LTP" value={fmt2(ms.ltp)} sub={`${ms.ltpChange >= 0 ? "+" : ""}${fmt2(ms.ltpChange)} (${ms.ltpChangePct >= 0 ? "+" : ""}${fmt2(ms.ltpChangePct)}%)`}
        tone={chgTone} />
      <StatCell label="HIGH"   value={fmt2(ms.dayHigh)} tone="#22c55e" />
      <StatCell label="LOW"    value={fmt2(ms.dayLow)}  tone="#ef4444" />
      <StatCell label="CHANGE" value={fmtUp(ms.change, true)}
        sub={`(${ms.changePct >= 0 ? "+" : ""}${fmt2(ms.changePct)}%)`} tone={chgTone} />
      <StatCell label="VOLUME (L)" value={fmt2(ms.volumeLakhs)} tone="rgba(255,255,255,0.85)" />
      <StatCell label="OI CHANGE" value={`${ms.oiChangePct >= 0 ? "+" : ""}${fmt2(ms.oiChangePct)}%`}
        tone={ms.oiChangePct >= 0 ? "#22c55e" : "#ef4444"} />
      <StatCell label="VWAP" value={fmt2(ms.vwap)} tone="#eab308" />
    </div>
  );
}

function StatCell({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: string }) {
  return (
    <div className="flex min-w-0 flex-col items-center justify-center rounded border border-white/10 bg-[#0a0f17] px-2 py-2">
      <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/55">{label}</span>
      <span className="font-mono text-[15px] font-black tabular-nums" style={{ color: tone }}>{value}</span>
      {sub ? <span className="truncate text-[10px] font-bold tabular-nums" style={{ color: tone }}>{sub}</span> : null}
    </div>
  );
}


/* ═══════════════ Generic Card shell ══════════════════════════════════ */
function Card({ title, children, className = "" }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex h-full min-h-0 flex-col rounded border border-white/10 bg-[#0a0f17] ${className}`}>
      {title ? (
        <div className="border-b border-white/8 px-3 py-1.5">
          <span className="text-[12px] font-bold uppercase tracking-[0.16em] text-cyan-300">{title}</span>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">{children}</div>
    </div>
  );
}

/* ═══════════════ CPR LEVELS CARD ═════════════════════════════════════ */
function CprLevelsCard({ data }: { data: CprCamResponse }) {
  const c = data.cpr;
  const rows = [
    { name: "TC (Top Central)",     value: c.tc,    tone: "#3b82f6" },  // blue (per image)
    { name: "PIVOT",                value: c.pivot, tone: "rgba(255,255,255,0.85)" },
    { name: "BC (Bottom Central)",  value: c.bc,    tone: "#ef4444" },
  ];
  return (
    <Card title="CPR LEVELS">
      <div className="flex flex-col gap-2">
        {rows.map((r) => (
          <div key={r.name} className="flex items-center justify-between text-[13px]">
            <span className="uppercase tracking-wide text-white/65" style={{ color: r.tone }}>{r.name}</span>
            <span className="font-mono font-black tabular-nums" style={{ color: r.tone }}>{fmt2(r.value)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ═══════════════ CPR WIDTH CARD ══════════════════════════════════════ */
function CprWidthCard({ data }: { data: CprCamResponse }) {
  const widthAbs = data.cpr.width;
  const isNarrow = data.cpr.widthClass === "narrow";
  const isWide   = data.cpr.widthClass === "wide";
  const cprType = isNarrow ? "NARROW CPR" : isWide ? "WIDE CPR" : "MEDIUM CPR";
  const expectation = isNarrow ? "EXPANSION / TREND DAY"
    : isWide ? "RANGE / ROTATION"
    : "BALANCED DAY";
  const typeTone = isNarrow ? "#a855f7" : isWide ? "#f97316" : "#94a3b8";
  const expTone  = isNarrow ? "#22c55e" : isWide ? "#eab308" : "#94a3b8";
  return (
    <Card>
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-bold uppercase tracking-[0.16em] text-white/55">CPR WIDTH</span>
        <span className="font-mono text-[14px] font-black text-white/85">{fmt2(widthAbs)}</span>
      </div>
      <div className="rounded border border-white/8 bg-white/[0.02] px-3 py-2">
        <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/45">CPR TYPE</div>
        <div className="text-[16px] font-black uppercase" style={{ color: typeTone }}>{cprType}</div>
      </div>
      <div className="rounded border border-white/8 bg-white/[0.02] px-3 py-2">
        <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/45">EXPECTATION</div>
        <div className="text-[14px] font-black uppercase" style={{ color: expTone }}>{expectation}</div>
      </div>
    </Card>
  );
}

/* ═══════════════ CAMARILLA LEVELS CARD ═══════════════════════════════ */
function CamLevelsCard({ data }: { data: CprCamResponse }) {
  const c = data.cam;
  const rows = [
    { name: "R4",    value: c.r4,    tone: "#a855f7" },
    { name: "R3",    value: c.r3,    tone: "#a855f7" },
    { name: "PIVOT", value: data.cpr.pivot, tone: "rgba(255,255,255,0.85)" },
    { name: "S3",    value: c.s3,    tone: "#a855f7" },
    { name: "S4",    value: c.s4,    tone: "#a855f7" },
  ];
  return (
    <Card title="CAMARILLA LEVELS">
      <div className="flex flex-col gap-2">
        {rows.map((r) => (
          <div key={r.name} className="flex items-center justify-between text-[13px]">
            <span className="font-bold uppercase tracking-wide" style={{ color: r.tone }}>{r.name}</span>
            <span className="font-mono font-black tabular-nums" style={{ color: r.tone }}>{fmt2(r.value)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ═══════════════ MARKET BIAS CARD ════════════════════════════════════ */
function MarketBiasCard({ data }: { data: CprCamResponse }) {
  const bias = data.cprInfo.bias;
  const tone = bias === "BULLISH" ? "#22c55e" : bias === "BEARISH" ? "#ef4444" : "#eab308";
  const sub = bias === "BULLISH" ? "PRICE ABOVE TC & ABOVE R3"
    : bias === "BEARISH" ? "PRICE BELOW BC & BELOW S3"
    : "INSIDE CPR · NO EDGE";
  const icon = bias === "BULLISH" ? "🐂" : bias === "BEARISH" ? "🐻" : "⏸";
  return (
    <Card title="MARKET BIAS">
      <div className="flex flex-1 flex-col items-center justify-center gap-1 rounded border px-2 py-3"
        style={{ borderColor: `${tone}66`, background: `${tone}10` }}>
        <span className="text-[28px]">{icon}</span>
        <span className="text-[24px] font-black uppercase leading-none" style={{ color: tone }}>{bias}</span>
        <span className="text-[10px] font-bold uppercase tracking-wide text-white/55">{sub}</span>
      </div>
    </Card>
  );
}


/* ═══════════════ CHART PANEL ═════════════════════════════════════════ */
function ChartPanel({ data }: { data: CprCamResponse }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const didFitRef = useRef<boolean>(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: "#0a0f17" },
        textColor: "rgba(226,232,240,0.78)",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      // Lock both axes — pan/zoom must persist across the 3-sec live polls.
      // Hide the LEFT price axis entirely (the duplicate level labels in the
      // image came from this scale being visible on both sides).
      leftPriceScale:  { visible: false },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)", autoScale: false, visible: true },
      timeScale: {
        borderColor: "rgba(255,255,255,0.08)",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
        lockVisibleTimeRangeOnResize: true,
        shiftVisibleRangeOnNewBar: false,
      },
      width: el.clientWidth,
      height: el.clientHeight || 260,
    });
    const series = chart.addCandlestickSeries({
      upColor: "#22c55e", downColor: "#ef4444",
      borderUpColor: "#16a34a", borderDownColor: "#dc2626",
      wickUpColor: "#22c55e", wickDownColor: "#ef4444",
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
      linesRef.current = [];
      didFitRef.current = false;
    };
  }, []);

  // Push candles
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    // Lightweight-charts renders timestamps in UTC. Dhan returns unix-seconds
    // in UTC, so 09:15 IST candles show up as "04:00" on the chart. Shift
    // every candle by IST offset (+5h30m) so the rendered axis labels read
    // in IST exactly the way every Indian-market platform displays them.
    const IST_OFFSET = 5.5 * 60 * 60; // seconds
    const arr = (data.chartCandles || [])
      .filter((c) => c.time > 0)
      .map((c) => ({
        time: (c.time + IST_OFFSET) as unknown as import("lightweight-charts").Time,
        open: c.open, high: c.high, low: c.low, close: c.close,
      }));
    series.setData(arr);
    if (arr.length > 0 && !didFitRef.current) {
      chart.priceScale("right").applyOptions({ autoScale: true });
      chart.timeScale().fitContent();
      requestAnimationFrame(() => {
        chart.priceScale("right").applyOptions({ autoScale: false });
      });
      didFitRef.current = true;
    }
  }, [data.chartCandles]);

  // Refit on timeframe change (each TF has very different bar density,
  // so the previously fitted range becomes meaningless).
  useEffect(() => {
    didFitRef.current = false;
  }, [data.interval]);

  // Draw level lines
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const l of linesRef.current) {
      try { series.removePriceLine(l); } catch (_) { /* noop */ }
    }
    linesRef.current = [];
    const lvls = [
      { price: data.cam.r4, color: "#a855f7", title: "R4", style: LineStyle.Dashed, width: 2 },
      { price: data.cam.r3, color: "#a855f7", title: "R3", style: LineStyle.Dashed, width: 2 },
      // CPR (TC / Pivot / BC) all in the same neutral cyan colour so the
      // central pivot range reads as ONE structural zone, not three.
      { price: data.cpr.tc,    color: "#38bdf8", title: "TC",    style: LineStyle.Solid, width: 2 },
      { price: data.cpr.pivot, color: "#38bdf8", title: "PIVOT", style: LineStyle.Solid, width: 2 },
      { price: data.cpr.bc,    color: "#38bdf8", title: "BC",    style: LineStyle.Solid, width: 2 },
      { price: data.cam.s3, color: "#a855f7", title: "S3", style: LineStyle.Dashed, width: 2 },
      { price: data.cam.s4, color: "#a855f7", title: "S4", style: LineStyle.Dashed, width: 2 },
    ];
    for (const lv of lvls) {
      if (!Number.isFinite(lv.price) || lv.price <= 0) continue;
      const ln = series.createPriceLine({
        price: lv.price, color: lv.color, lineWidth: lv.width as 1 | 2 | 3 | 4,
        lineStyle: lv.style, axisLabelVisible: true, title: lv.title,
      });
      linesRef.current.push(ln);
    }
  }, [data.cam, data.cpr]);

  return (
    <Card title={`${tfLabel(data.interval || "5")} CHART`}>
      <div className="min-h-[260px] flex-1" ref={containerRef} />
    </Card>
  );
}

function tfLabel(intv: string): string {
  switch (String(intv)) {
    case "1":  return "1 MIN";
    case "3":  return "3 MIN";
    case "5":  return "5 MIN";
    case "15": return "15 MIN";
    case "30": return "30 MIN";
    case "60": return "1 HOUR";
    default:   return `${intv} MIN`;
  }
}


/* ═══════════════ DAY TYPE GUIDE ══════════════════════════════════════ */
function DayTypeGuideCard({ data }: { data: CprCamResponse }) {
  return (
    <Card title="DAY TYPE GUIDE">
      {data.dayTypeGuide.map((row) => <DayTypeRow key={row.key} row={row} />)}
    </Card>
  );
}
function DayTypeRow({ row }: { row: CCDayTypeGuideRow }) {
  const tone = row.key === "NARROW CPR" ? "#a855f7" : "#f97316";
  const icon = row.key === "NARROW CPR" ? "⊐⊏" : "↔";
  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-3 rounded border px-2 py-1.5"
      style={{ borderColor: row.active ? `${tone}88` : "rgba(255,255,255,0.10)", background: row.active ? `${tone}14` : "transparent" }}>
      <div className="flex flex-col items-center gap-0.5 px-1">
        <span className="text-[14px] font-black" style={{ color: tone }}>{icon}</span>
        <span className="text-[10px] font-black uppercase tracking-wide" style={{ color: tone }}>{row.key}</span>
      </div>
      <div className="flex flex-col">
        <span className="text-[11px] font-bold uppercase text-white/80">{row.headline}</span>
        <span className="text-[10px] uppercase text-white/55">{row.desc}</span>
      </div>
    </div>
  );
}

/* ═══════════════ KEY LEVELS SUMMARY ══════════════════════════════════ */
function KeyLevelsSummaryCard({ data }: { data: CprCamResponse }) {
  const cpr = data.keyLevelsSummary.cpr;
  const cam = data.keyLevelsSummary.cam;
  return (
    <Card title="KEY LEVELS SUMMARY">
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          {cpr.map((r) => (
            <div key={r.name} className="flex items-center justify-between text-[11px]">
              <span className="truncate uppercase tracking-wide"
                style={{ color: r.tone === "bull" ? "#3b82f6" : r.tone === "bear" ? "#ef4444" : "rgba(255,255,255,0.85)" }}>
                {r.name}
              </span>
              <span className="font-mono font-black tabular-nums"
                style={{ color: r.tone === "bull" ? "#3b82f6" : r.tone === "bear" ? "#ef4444" : "rgba(255,255,255,0.85)" }}>
                {fmt2(r.value)}
              </span>
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-1">
          {cam.map((r) => (
            <div key={r.name} className="flex items-center justify-between text-[11px]">
              <span className="font-bold uppercase tracking-wide" style={{ color: "#a855f7" }}>{r.name}</span>
              <span className="font-mono font-black tabular-nums" style={{ color: "#a855f7" }}>{fmt2(r.value)}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

/* ═══════════════ SCENARIO GUIDE ══════════════════════════════════════ */
function ScenarioGuideCard({ data }: { data: CprCamResponse }) {
  return (
    <Card title="SCENARIO GUIDE">
      <div className="flex flex-1 flex-col gap-1.5">
        {data.scenarioGuide.map((row) => <ScenarioRow key={row.id} row={row} />)}
      </div>
    </Card>
  );
}
function ScenarioRow({ row }: { row: CCScenarioRow }) {
  const tone = tc(row.tone);
  return (
    <div className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-2 rounded border px-2 py-1.5"
      style={{ borderColor: row.active ? `${tone}88` : "rgba(255,255,255,0.08)", background: row.active ? `${tone}10` : "transparent" }}>
      <span className="text-[18px] leading-none" style={{ color: tone }}>{row.icon}</span>
      <span className="truncate text-[12px] uppercase tracking-wide text-white/80">{row.cond}</span>
      <span className="truncate text-[11px] uppercase text-white/55">{row.result}</span>
      <span className="rounded px-2 py-0.5 text-[11px] font-black uppercase tracking-wide"
        style={{ background: `${tone}1f`, color: tone, border: `1px solid ${tone}66` }}>
        {row.action}
      </span>
    </div>
  );
}

/* ═══════════════ TRADE SETUP CARD ════════════════════════════════════ */
function TradeSetupCard({ data }: { data: CprCamResponse }) {
  const t = data.tradeSetup;
  const actionTone = tc(t.tone);
  const rows = [
    { icon: "🎯", label: "SETUP",    value: t.setup,    tone: "#22c55e" },
    { icon: "◎",  label: "ACTION",   value: t.action,   tone: actionTone },
    { icon: "↗",  label: "TARGET",   value: t.target,   tone: "#a855f7" },
    { icon: "✕",  label: "STOPLOSS", value: t.stoploss, tone: "#ef4444" },
  ];
  return (
    <Card title="TRADE SETUP (BUYER LOGIC)">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[24px_90px_1fr] items-center gap-2 rounded border border-white/8 bg-white/[0.02] px-2 py-1.5">
          <span className="text-center text-[14px]" style={{ color: r.tone }}>{r.icon}</span>
          <span className="text-[11px] font-bold uppercase tracking-wide text-white/65">{r.label}</span>
          <span className="truncate text-right text-[12px] font-black uppercase tracking-wide" style={{ color: r.tone }}>{r.value}</span>
        </div>
      ))}
    </Card>
  );
}

/* ═══════════════ CONFLUENCE CHECK CARD ═══════════════════════════════ */
function ConfluenceCheckCard({ data }: { data: CprCamResponse }) {
  const c = data.confluenceCheck;
  const tone = tc(c.tone);
  return (
    <Card title="CONFLUENCE CHECK">
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <div className="flex flex-col gap-1">
          {c.items.map((it, i) => (
            <div key={i} className="flex items-center justify-between rounded border border-white/8 bg-white/[0.02] px-2 py-1 text-[11px]">
              <span className="truncate uppercase tracking-wide text-white/70">{it.label}</span>
              <span className="text-[14px] leading-none" style={{ color: it.ok ? "#22c55e" : "rgba(255,255,255,0.30)" }}>
                {it.ok ? "✓" : "○"}
              </span>
            </div>
          ))}
        </div>
        <div className="flex w-[110px] flex-col items-center justify-center rounded border px-2 py-2"
          style={{ borderColor: `${tone}66`, background: `${tone}14` }}>
          <span className="text-[10px] font-bold uppercase tracking-wide text-white/55">CONFLUENCE</span>
          <span className="text-[10px] font-bold uppercase tracking-wide text-white/55">SCORE</span>
          <span className="font-mono text-[26px] font-black leading-none" style={{ color: tone }}>{c.score}/{c.total}</span>
          <span className="mt-1 text-center text-[10px] font-black uppercase leading-tight" style={{ color: tone }}>{c.label}</span>
        </div>
      </div>
    </Card>
  );
}

/* ═══════════════ FOOTER STRIP ════════════════════════════════════════ */
function FooterStrip() {
  return (
    <div className="flex flex-wrap items-center justify-center gap-3 rounded border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-[11px] uppercase tracking-[0.16em]">
      <span className="text-amber-300">⚙ CPR = MARKET STRUCTURE</span>
      <span className="text-white/30">·</span>
      <span className="text-amber-300">CAMARILLA = TRIGGER LEVELS</span>
      <span className="text-white/30">·</span>
      <span className="text-white/65">COMBINE WITH OI, VWAP &amp; FRVP FOR HIGH PROBABILITY OPTION TRADES</span>
    </div>
  );
}
