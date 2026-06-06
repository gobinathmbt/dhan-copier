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
  CCSymbol, CprCamResponse, CCLogicCard, CCTrendContextRow,
} from "@/lib/cprCamTypes";

export const Route = createFileRoute("/cpr-cam")({
  component: CprCamPage,
});

/**
 * CPR + CAMARILLA POWER ENGINE — standalone dashboard
 * ======================================================================
 * TC / Pivot / BC + Camarilla S3·S4·R3·R4 (S5/R5/S6/R6 extension levels)
 * → BUY CE / BUY PE / WAIT verdict + targets, invalidation, strength
 * meter, logic cards, price-flow map, trend-context grid, and a 5-min
 * candlestick chart with all levels overlaid.
 */
function CprCamPage() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!isAuthenticated()) navigate({ to: "/login" });
  }, [navigate]);

  const [symbol, setSymbol] = useState<CCSymbol>("NIFTY_50");
  const [date, setDate] = useState<string | null>(null);
  const { data, loading, lastFetchAt, refetch } = useCprCam({
    symbol, date, intervalMs: date ? 0 : 3000,
  });

  return (
    <div className="cprcam-root fixed inset-0 left-3 flex flex-col bg-black font-sans text-white">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#05070b] px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="text-[15px] font-bold tracking-[0.18em] text-cyan-300">
            CPR + CAMARILLA <span className="rounded-sm bg-cyan-400/15 px-1.5 py-0.5 text-[12px]">POWER</span>
          </span>
          <span className="text-[12px] uppercase tracking-[0.16em] text-white/55">
            CPR (TC / PIVOT / BC) + CAMARILLA (S3 / R3 / S4 / R4) LOGIC ENGINE
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md bg-white/[0.05] p-0.5">
            {(["NIFTY_50", "SENSEX"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSymbol(s)}
                className={`rounded px-3 py-1 text-[13px] font-bold tracking-wider transition-colors ${
                  symbol === s ? "bg-cyan-500/20 text-cyan-300" : "text-white/55 hover:text-white"
                }`}
              >
                {s === "NIFTY_50" ? "NIFTY" : "SENSEX"}
              </button>
            ))}
          </div>
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
          >LIVE</button>
          <button onClick={() => refetch()} disabled={loading}
            className="rounded-md border border-white/10 bg-white/[0.04] px-3 py-1 text-[13px] text-white/65">
            {loading ? "…" : "↻"}
          </button>
          <span className="text-[11px] text-white/45">
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

/* ─── tone → color ───────────────────────────────────────────────── */
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
function fmt0(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—";
}
function fmt2(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}


/* ═════════════════════════════════════════════════════════════════════
 *  DASHBOARD — full layout matching the reference image
 * ═════════════════════════════════════════════════════════════════════ */
function Dashboard({ data }: { data: CprCamResponse }) {
  return (
    <div className="flex flex-col gap-2 pb-2">
      {/* Title bar with the 4 top cards */}
      <TitleBar data={data} />

      {/* Main 12-col row: left (CPR + Camarilla level tables), center (chart), right (signal panel + strength + trend ctx) */}
      <div className="grid grid-cols-12 gap-2">
        <div className="col-span-3 flex min-w-0 flex-col gap-2">
          <CprInfoCard data={data} />
          <CamLevelsCard data={data} />
        </div>
        <div className="col-span-6 min-h-[460px] min-w-0"><ChartPanel data={data} /></div>
        <div className="col-span-3 flex min-w-0 flex-col gap-2">
          <SignalPanel data={data} />
          <MarketStrengthCard data={data} />
          <TrendContextCard data={data} />
        </div>
      </div>

      {/* Logic cards — 4 across */}
      <div className="grid grid-cols-12 gap-2">
        {data.logicCards.map((card, i) => (
          <div key={i} className="col-span-3 min-w-0"><LogicCard card={card} /></div>
        ))}
      </div>

      {/* Footer row: price flow map + quick summary + final decision */}
      <div className="grid grid-cols-12 gap-2">
        <div className="col-span-6 min-w-0"><PriceFlowMap data={data} /></div>
        <div className="col-span-3 min-w-0"><QuickSummary data={data} /></div>
        <div className="col-span-3 min-w-0"><FinalDecision data={data} /></div>
      </div>
    </div>
  );
}

/* ═══════════════ TITLE BAR ═══════════════════════════════════════════ */
function TitleBar({ data }: { data: CprCamResponse }) {
  const h = data.header;
  const biasTone = tc(h.bias);
  const sigTone  = tc(h.signalTone);
  return (
    <div className="grid grid-cols-12 items-stretch gap-2">
      {/* Title — 4 cols */}
      <div className="col-span-4 flex min-w-0 flex-col justify-center rounded border border-white/15 bg-[#0a0f17] px-3 py-2">
        <div className="truncate text-[18px] font-black uppercase tracking-wide text-white/95">
          CPR + CAMARILLA POWER DASHBOARD
        </div>
        <div className="truncate text-[10px] uppercase tracking-[0.16em] text-cyan-300">
          CPR (TC / PIVOT / BC) + CAMARILLA (S3 / R3 / S4 / R4) LOGIC ENGINE
        </div>
      </div>

      {/* 4 top cards — 2 cols each = 8 cols */}
      <div className="col-span-2 min-w-0"><TopCard label="MARKET BIAS" value={h.bias}
        icon={h.bias === "BULLISH" ? "🐂" : h.bias === "BEARISH" ? "🐻" : "•"} tone={biasTone} /></div>
      <div className="col-span-2 min-w-0"><TopCard label="DAY TYPE" value={h.dayType.replace(" DAY", "")} sub="DAY"
        icon="📊" tone="#94a3b8" /></div>
      <div className="col-span-2 min-w-0"><TopCard label="CPR WIDTH" value={h.cprWidth}
        icon={h.cprWidth === "NARROW" ? "🚀" : h.cprWidth === "WIDE" ? "↔️" : "—"} tone="#a855f7" /></div>
      <div className="col-span-2 min-w-0"><TopCard label="FINAL SIGNAL" value={h.signal}
        icon={h.signal === "BUY CE" ? "📈" : h.signal === "BUY PE" ? "📉" : "⏸"} tone={sigTone} /></div>
    </div>
  );
}

function TopCard({ label, value, sub, icon, tone }: { label: string; value: string; sub?: string; icon?: string; tone: string }) {
  return (
    <div className="flex h-full flex-col justify-center rounded border bg-[#0a0f17] px-3 py-2"
      style={{ borderColor: `${tone}66`, background: `${tone}10` }}>
      <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/55">{label}</span>
      <div className="flex items-baseline gap-1">
        <span className="text-[18px]">{icon}</span>
        <span className="truncate text-[15px] font-black uppercase tracking-wide leading-tight" style={{ color: tone }}>
          {value}
        </span>
        {sub ? <span className="text-[11px] uppercase text-white/55">{sub}</span> : null}
      </div>
    </div>
  );
}


/* ═══════════════ CPR INFORMATION CARD ════════════════════════════════ */
function CprInfoCard({ data }: { data: CprCamResponse }) {
  const c = data.cprInfo;
  const biasTone = tc(c.bias);
  return (
    <Panel title="CPR INFORMATION" accent="#1e3a5f">
      <Row label="TC (Top Central)" value={fmt2(c.tc)} valueTone="#22c55e" />
      <Row label="PIVOT (CENTRAL)"  value={fmt2(c.pivot)} valueTone="#eab308" />
      <Row label="BC (BOTTOM CENTRAL)" value={fmt2(c.bc)} valueTone="#ef4444" />
      <div className="my-1 border-t border-white/10" />
      <Row label="CPR BIAS" value={c.bias} valueTone={biasTone} />
      <Row label="CPR POSITION" value={c.position} />
      <Row label="CPR WIDTH" value={c.width}
        valueTone={c.width === "NARROW" ? "#a855f7" : c.width === "WIDE" ? "#f97316" : "#94a3b8"} />
      <Row label="TODAY vs YESTERDAY" value={c.todayVsYesterday}
        valueTone={c.todayVsYesterday === "HIGHER" ? "#22c55e" : c.todayVsYesterday === "LOWER" ? "#ef4444" : "#94a3b8"} />
    </Panel>
  );
}

/* ═══════════════ CAMARILLA LEVELS CARD ═══════════════════════════════ */
function CamLevelsCard({ data }: { data: CprCamResponse }) {
  const lv = data.camLevels;
  const rows = [
    { name: "R4", value: lv.r4.value, label: lv.r4.label, tone: "#ef4444" },
    { name: "R3", value: lv.r3.value, label: lv.r3.label, tone: "#f97316" },
    { name: "PIVOT", value: lv.pivot.value, label: lv.pivot.label, tone: "#eab308" },
    { name: "S3", value: lv.s3.value, label: lv.s3.label, tone: "#22c55e" },
    { name: "S4", value: lv.s4.value, label: lv.s4.label, tone: "#16c784" },
  ];
  return (
    <Panel title="CAMARILLA LEVELS" accent="#3a1e5f">
      {rows.map((r) => (
        <div key={r.name} className="grid grid-cols-[44px_1fr_auto] items-center gap-1.5 rounded border border-white/10 bg-white/[0.02] px-1.5 py-1">
          <span className="rounded px-1 py-0.5 text-center text-[10px] font-black"
            style={{ background: `${r.tone}1f`, color: r.tone, border: `1px solid ${r.tone}55` }}>
            {r.name}
          </span>
          <span className="truncate font-mono text-[12px] font-black text-white/85">{fmt2(r.value)}</span>
          <span className="truncate text-[9px] font-black uppercase tracking-wide" style={{ color: r.tone }}>{r.label}</span>
        </div>
      ))}
    </Panel>
  );
}

function Panel({ title, accent = "#1e3a5f", children }: { title?: string; accent?: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col rounded border border-white/15 bg-[#0a0f17]">
      {title ? (
        <div className="rounded-t px-2 py-1.5 text-center text-[12px] font-bold uppercase tracking-[0.10em] text-cyan-300"
          style={{ background: accent }}>{title}</div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col gap-1 p-2">{children}</div>
    </div>
  );
}

function Row({ label, value, valueTone }: { label: string; value: string; valueTone?: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 rounded border border-white/8 bg-white/[0.02] px-2 py-1 text-[11px]">
      <span className="truncate uppercase tracking-wide text-white/55">{label}</span>
      <span className="truncate font-mono font-black uppercase" style={{ color: valueTone || "rgba(255,255,255,0.85)" }}>{value}</span>
    </div>
  );
}


/* ═══════════════ CHART PANEL ════════════════════════════════════════ */
function ChartPanel({ data }: { data: CprCamResponse }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);

  // Init chart once
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
    };
  }, []);

  // Push candles
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    const arr = (data.chartCandles || [])
      .filter((c) => c.time > 0)
      .map((c) => ({
        time: c.time as unknown as import("lightweight-charts").Time,
        open: c.open, high: c.high, low: c.low, close: c.close,
      }));
    series.setData(arr);
    if (arr.length > 0) chart.timeScale().fitContent();
  }, [data.chartCandles]);

  // Draw level lines (CPR + Camarilla)
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const l of linesRef.current) {
      try { series.removePriceLine(l); } catch (_) { /* noop */ }
    }
    linesRef.current = [];
    const lvls = [
      { price: data.cam.r6, color: "#ef4444", title: `R6 (${fmt2(data.cam.r6)})`, style: LineStyle.Dotted, width: 1 },
      { price: data.cam.r5, color: "#ef4444", title: `R5 (${fmt2(data.cam.r5)})`, style: LineStyle.Dotted, width: 1 },
      { price: data.cam.r4, color: "#ef4444", title: `R4 (${fmt2(data.cam.r4)})`, style: LineStyle.Solid,  width: 2 },
      { price: data.cam.r3, color: "#f97316", title: `R3 (${fmt2(data.cam.r3)})`, style: LineStyle.Dashed, width: 2 },
      { price: data.cpr.tc, color: "#22c55e", title: `TC (${fmt2(data.cpr.tc)})`, style: LineStyle.Solid,  width: 2 },
      { price: data.cpr.pivot, color: "#eab308", title: `PIVOT (${fmt2(data.cpr.pivot)})`, style: LineStyle.Solid, width: 2 },
      { price: data.cpr.bc, color: "#ef4444", title: `BC (${fmt2(data.cpr.bc)})`, style: LineStyle.Solid,  width: 2 },
      { price: data.cam.s3, color: "#22c55e", title: `S3 (${fmt2(data.cam.s3)})`, style: LineStyle.Dashed, width: 2 },
      { price: data.cam.s4, color: "#16c784", title: `S4 (${fmt2(data.cam.s4)})`, style: LineStyle.Solid,  width: 2 },
      { price: data.cam.s5, color: "#16c784", title: `S5 (${fmt2(data.cam.s5)})`, style: LineStyle.Dotted, width: 1 },
      { price: data.cam.s6, color: "#16c784", title: `S6 (${fmt2(data.cam.s6)})`, style: LineStyle.Dotted, width: 1 },
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
    <Panel title={`${data.displayName} · 5m TIMEFRAME`} accent="#0e2436">
      <div className="mb-1 flex min-w-0 flex-wrap items-center justify-between gap-2 text-[11px] uppercase tracking-wide">
        <div className="flex flex-wrap items-center gap-2 text-white/65">
          <span>O <span className="font-mono text-white/85">{fmt2(data.priorClose)}</span></span>
          <span>H <span className="font-mono text-emerald-400">{fmt2(data.dayHigh)}</span></span>
          <span>L <span className="font-mono text-rose-400">{fmt2(data.dayLow)}</span></span>
          <span>C <span className="font-mono text-amber-300">{fmt2(data.spot)}</span></span>
          <span className="font-mono"
            style={{ color: data.spotChange >= 0 ? "#22c55e" : "#ef4444" }}>
            {data.spotChange >= 0 ? "+" : ""}{data.spotChange.toFixed(2)}{" "}
            ({data.spotChangePct >= 0 ? "+" : ""}{data.spotChangePct.toFixed(2)}%)
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-white/55">
          <span className="rounded px-2 py-0.5 text-[10px] font-black uppercase"
            style={{
              background: data.source === "live" ? "#22c55e1f" : "#94a3b81f",
              color: data.source === "live" ? "#22c55e" : "#94a3b8",
              border: `1px solid ${data.source === "live" ? "#22c55e66" : "#94a3b866"}`,
            }}>
            {data.source === "live" ? "● LIVE" : "FOLDER"}
          </span>
          <span className="truncate rounded px-2 py-0.5 text-[10px] font-black uppercase"
            style={{ background: `${tc(data.statusTone)}1f`, color: tc(data.statusTone), border: `1px solid ${tc(data.statusTone)}66`, maxWidth: 240 }}>
            {data.status} · {data.strengthLabel}
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1" ref={containerRef} />
    </Panel>
  );
}


/* ═══════════════ SIGNAL PANEL ════════════════════════════════════════ */
function SignalPanel({ data }: { data: CprCamResponse }) {
  const sp = data.signalPanel;
  const color = tc(sp.signalTone);
  return (
    <Panel title="SIGNAL PANEL" accent="#1e4d4a">
      <div className="rounded border px-3 py-3 text-center"
        style={{ borderColor: `${color}88`, background: `${color}14` }}>
        <span className="text-[36px] font-black uppercase tracking-wide leading-none" style={{ color }}>
          {sp.signal}
        </span>
        <div className="mt-1 text-[20px]">
          {sp.signal === "BUY CE" ? "📈" : sp.signal === "BUY PE" ? "📉" : "⏸"}
        </div>
      </div>
      <div className="rounded border px-2 py-1 text-center text-[12px] font-black uppercase tracking-wide"
        style={{ borderColor: `${color}55`, background: `${color}10`, color }}>
        {sp.signal === "BUY CE" ? "STRONG BULLISH SETUP"
          : sp.signal === "BUY PE" ? "STRONG BEARISH SETUP"
          : "NO TRADE — WAIT"}
      </div>
      <SignalRow label="SETUP"        value={sp.setupLabel} />
      <SignalRow label="TREND"        value={sp.trend}
        valueTone={sp.trend === "UPTREND" ? "#22c55e" : sp.trend === "DOWNTREND" ? "#ef4444" : "#94a3b8"} />
      <SignalRow label="CONFIDENCE"   value={`${sp.confidence}%`} valueTone={color}
        bar={sp.confidence} barColor={color} />
      <SignalRow label="SUGGESTION"   value={sp.suggestion} />
      <SignalRow label="INVALIDATION" value={sp.invalidation}
        valueTone="#ef4444" />
      {sp.targets.map((t, i) => (
        <SignalRow key={i} label={`TARGET ${i + 1}`}
          value={`${t.name} (${fmt2(t.value)})`}
          valueTone="#22c55e" />
      ))}
      <SignalRow label="RISK TO REWARD"
        value={sp.riskReward > 0 ? `1 : ${sp.riskReward.toFixed(1)}` : "—"}
        valueTone={sp.riskReward >= 1.5 ? "#22c55e" : sp.riskReward > 0 ? "#eab308" : "#94a3b8"} />
    </Panel>
  );
}
function SignalRow({ label, value, valueTone, bar, barColor }: { label: string; value: string; valueTone?: string; bar?: number; barColor?: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 rounded border border-white/8 bg-white/[0.02] px-2 py-1 text-[11px]">
      <span className="truncate uppercase tracking-wide text-white/55">{label}</span>
      <div className="flex min-w-0 items-center gap-2">
        {typeof bar === "number" ? (
          <div className="h-2 w-12 overflow-hidden rounded-full bg-white/10">
            <div className="h-full" style={{ width: `${bar}%`, background: barColor || "#22c55e" }} />
          </div>
        ) : null}
        <span className="truncate font-mono font-black uppercase" style={{ color: valueTone || "rgba(255,255,255,0.85)" }}>{value}</span>
      </div>
    </div>
  );
}

/* ═══════════════ MARKET STRENGTH METER ═══════════════════════════════ */
function MarketStrengthCard({ data }: { data: CprCamResponse }) {
  const m = data.marketStrength;
  return (
    <Panel title="MARKET STRENGTH" accent="#3a2a5f">
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col items-center rounded border border-emerald-500/40 bg-emerald-500/[0.08] px-2 py-1.5">
          <span className="text-[10px] font-bold uppercase tracking-wide text-emerald-300">BUYERS</span>
          <span className="font-mono text-[24px] font-black text-emerald-400">{m.buyersPct}%</span>
        </div>
        <div className="flex flex-col items-center rounded border border-rose-500/40 bg-rose-500/[0.08] px-2 py-1.5">
          <span className="text-[10px] font-bold uppercase tracking-wide text-rose-300">SELLERS</span>
          <span className="font-mono text-[24px] font-black text-rose-400">{m.sellersPct}%</span>
        </div>
      </div>
      {/* Gauge bar */}
      <div className="relative h-3 overflow-hidden rounded-full bg-white/10">
        <div className="absolute inset-y-0 left-0 bg-emerald-500" style={{ width: `${m.buyersPct}%` }} />
        <div className="absolute inset-y-0 right-0 bg-rose-500" style={{ width: `${m.sellersPct}%` }} />
      </div>
      <div className="rounded border border-white/10 bg-white/[0.02] px-2 py-1 text-center text-[11px] font-black uppercase">
        MARKET CONTROL :{" "}
        <span style={{ color: m.marketControl === "BUYERS" ? "#22c55e" : m.marketControl === "SELLERS" ? "#ef4444" : "#eab308" }}>
          {m.marketControl}
        </span>
      </div>
    </Panel>
  );
}

/* ═══════════════ TREND CONTEXT ═══════════════════════════════════════ */
function TrendContextCard({ data }: { data: CprCamResponse }) {
  return (
    <Panel title="TREND CONTEXT" accent="#1e4d4a">
      {data.trendContext.map((row, i) => <TrendRow key={i} row={row} />)}
    </Panel>
  );
}
function TrendRow({ row }: { row: CCTrendContextRow }) {
  const color = row.tone === "bull" ? "#22c55e" : row.tone === "bear" ? "#ef4444" : "#94a3b8";
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 rounded border border-white/8 bg-white/[0.02] px-2 py-1 text-[11px]">
      <span className="truncate uppercase tracking-wide text-white/55">{row.label}</span>
      <span className="font-mono font-black uppercase" style={{ color }}>
        {row.relation} {row.relation === "ABOVE" ? "↑" : "↓"}
      </span>
    </div>
  );
}


/* ═══════════════ LOGIC CARDS (S3 Support / R3 Reject / R3 Break / S3 Break) ══ */
function LogicCard({ card }: { card: CCLogicCard }) {
  const color = tc(card.actionTone);
  const accent =
    card.title.startsWith("S3 SUPPORT") ? "#1e3a5f" :
    card.title.startsWith("R3 REJECTION") ? "#5f1e2e" :
    card.title.startsWith("R3 BREAK") ? "#1e4d2e" :
    "#5f1e1e";
  const icon =
    card.title.startsWith("S3 SUPPORT") ? "🛡" :
    card.title.startsWith("R3 REJECTION") ? "🛑" :
    card.title.startsWith("R3 BREAK") ? "🚀" :
    "⚠";
  return (
    <Panel title={`${icon}  ${card.title}`} accent={accent}>
      {card.items.map((it, i) => (
        <div key={i} className="flex items-center justify-between rounded border border-white/8 bg-white/[0.02] px-2 py-1 text-[11px]">
          <span className="uppercase tracking-wide text-white/65">{it.label}</span>
          <span className="text-[14px]" style={{ color: it.ok ? "#22c55e" : "rgba(255,255,255,0.30)" }}>
            {it.ok ? "✔" : "○"}
          </span>
        </div>
      ))}
      <div className="mt-auto flex items-center justify-between rounded border px-2 py-1.5"
        style={{ borderColor: `${color}66`, background: `${color}14` }}>
        <span className="text-[11px] font-bold uppercase tracking-wide text-white/60">ACTION</span>
        <span className="text-[13px] font-black uppercase tracking-wide" style={{ color }}>{card.action}</span>
      </div>
    </Panel>
  );
}

/* ═══════════════ PRICE FLOW MAP ══════════════════════════════════════ */
function PriceFlowMap({ data }: { data: CprCamResponse }) {
  const f = data.flowMap;
  const color = tc(data.signalPanel.signalTone);
  return (
    <Panel title="PRICE FLOW MAP" accent="#1e2a4d">
      <div className="flex items-stretch gap-1 overflow-x-auto py-1">
        {f.map((s, i) => (
          <div key={i} className="flex items-center gap-1">
            <div className="flex flex-col items-center rounded border px-2 py-1.5"
              style={{ borderColor: `${color}66`, background: `${color}10`, minWidth: 90 }}>
              <span className="text-[10px] font-black uppercase" style={{ color }}>{s.name}</span>
              <span className="font-mono text-[12px] font-black text-white/85">{fmt2(s.value)}</span>
            </div>
            {i < f.length - 1 ? (
              <span className="text-[18px] leading-none" style={{ color }}>→</span>
            ) : null}
          </div>
        ))}
      </div>
      <div className="text-center text-[11px] font-black uppercase tracking-[0.16em]"
        style={{ color }}>
        IDEAL FLOW : {data.flowIdeal}
      </div>
    </Panel>
  );
}

/* ═══════════════ QUICK SUMMARY ═══════════════════════════════════════ */
function QuickSummary({ data }: { data: CprCamResponse }) {
  return (
    <Panel title="QUICK SUMMARY" accent="#1e3a5f">
      {data.quickSummary.map((s, i) => (
        <div key={i} className="flex items-start gap-2 rounded border border-white/8 bg-white/[0.02] px-2 py-1 text-[11px]">
          <span className="text-[14px] leading-none" style={{ color: s.ok ? "#22c55e" : "rgba(255,255,255,0.35)" }}>
            {s.ok ? "✔" : "○"}
          </span>
          <span className="uppercase tracking-wide" style={{ color: s.ok ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.45)" }}>
            {s.label}
          </span>
        </div>
      ))}
    </Panel>
  );
}

/* ═══════════════ FINAL DECISION BANNER ═══════════════════════════════ */
function FinalDecision({ data }: { data: CprCamResponse }) {
  const sp = data.signalPanel;
  const color = tc(sp.signalTone);
  const tagline =
    sp.signal === "BUY CE" ? "RIDE THE BULL TREND"
    : sp.signal === "BUY PE" ? "RIDE THE BREAKDOWN"
    : "WAIT FOR DIRECTION";
  return (
    <div className="flex flex-col items-center justify-center rounded border-2 px-3 py-3"
      style={{ borderColor: color, background: `${color}14` }}>
      <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-white/55">FINAL DECISION</span>
      <div className="flex items-baseline gap-2">
        <span className="text-[34px]">{sp.signal === "BUY CE" ? "🐂" : sp.signal === "BUY PE" ? "🐻" : "⏸"}</span>
        <span className="text-[34px] font-black uppercase tracking-wide leading-none" style={{ color }}>
          {sp.signal}
        </span>
      </div>
      <span className="mt-1 text-[12px] font-bold uppercase tracking-wide" style={{ color }}>
        {tagline}
      </span>
    </div>
  );
}
