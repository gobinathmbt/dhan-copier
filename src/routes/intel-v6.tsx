import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { isAuthenticated } from "@/lib/auth";
import { useIntelV6Decision } from "@/hooks/useIntelV6Decision";
import type { V6Symbol, V6Decision, V6StrikeRow } from "@/lib/intelV6Types";

export const Route = createFileRoute("/intel-v6")({
  component: IntelV6Page,
});

/**
 * INTEL V6 — PREMIUM INTELLIGENCE ENGINE (Option Greeks Engine)
 * ========================================================================
 * Premium Behaviour layer that sits below the V5 structure verdict.
 *   • 4 Greek engines (Delta · Gamma · Theta · Vega)
 *   • Premium Power Score gauge
 *   • Greeks Momentum Matrix
 *   • Strike Dominance (ATM ± 5)
 *   • Futures & Breadth + Session & Risk
 *   • Option Buyer Action Plan + Greeks Summary rail
 *   • Final Verdict bar
 */
function IntelV6Page() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!isAuthenticated()) navigate({ to: "/login" });
  }, [navigate]);

  const [symbol, setSymbol] = useState<V6Symbol>("NIFTY_50");
  const [date, setDate] = useState<string | null>(null);
  const { data, loading, lastFetchAt, refetch } = useIntelV6Decision({ symbol, date, intervalMs: 3000 });

  return (
    <div className="intelv6-root fixed inset-0 left-16 flex flex-col bg-[#060a10] font-mono text-white">
      <header className="flex items-center justify-between border-b border-white/[0.08] bg-[#0a0e15] px-5 py-2">
        <div className="flex items-center gap-3">
          <span className="text-[14px] font-bold tracking-[0.20em] text-cyan-300">
            INTEL <span className="rounded-sm bg-cyan-400/15 px-2 py-0.5 text-[12px]">V6</span>
          </span>
          <span className="text-[11px] uppercase tracking-[0.18em] text-white/55">
            Premium Intelligence · Greeks Engine
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md bg-white/[0.04] p-0.5">
            {(["NIFTY_50", "SENSEX"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSymbol(s)}
                className={`rounded px-3 py-1 text-[12px] font-bold tracking-wider transition-colors ${
                  symbol === s ? "bg-sky-500/20 text-sky-300" : "text-white/55 hover:text-white"
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
            className="rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[12px] text-white/85 outline-none [color-scheme:dark]"
          />
          <button
            onClick={() => setDate(null)}
            className={`rounded px-2 py-1 text-[11px] font-bold tracking-wider ${
              !date ? "bg-emerald-500/20 text-emerald-400" : "bg-white/5 text-white/55"
            }`}
          >
            LIVE
          </button>
          <button
            onClick={() => refetch()}
            disabled={loading}
            className="rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-[12px] text-white/65"
          >
            {loading ? "…" : "↻"}
          </button>
          <span className="text-[10px] text-white/45">
            {lastFetchAt ? `${Math.round((Date.now() - lastFetchAt) / 1000)}s` : "—"}
          </span>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
        {!data ? (
          <div className="flex h-full items-center justify-center text-[14px] text-white/45">Loading V6…</div>
        ) : !data.ok ? (
          <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-6 text-rose-300">
            <div className="text-[13px] font-bold uppercase tracking-wider">Engine Error</div>
            <div className="mt-2 text-[12px]">{(data as unknown as { error?: string }).error || "Unable to load."}</div>
          </div>
        ) : (
          <V6Dashboard data={data} />
        )}
      </main>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * V6Dashboard — full layout matching the reference image.
 *   Row 1: [ Premium Intelligence (4 greek engines + power gauge) ]  [ Action Plan ]
 *   Row 2: [ Greeks Momentum Matrix strip ]
 *   Row 3: [ Strike Dominance ] [ Futures & Breadth ] [ Session & Risk ] [ Greeks Summary ]
 *   Row 4: [ Final Verdict bar + Trade Edge ]
 * ───────────────────────────────────────────────────────────────────── */
function V6Dashboard({ data }: { data: V6Decision }) {
  const verdictTone = toneFor(data.actionPlan.marketBias);

  return (
    <div className="flex w-full flex-col gap-3">
      {/* ── TOP: Premium Intelligence panel + Action Plan ─────────────── */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_320px]">
        <PremiumIntelligencePanel data={data} />
        <div className="flex flex-col gap-3">
          <ActionPlanCard data={data} />
          <GreeksSummaryCard data={data} />
        </div>
      </div>

      {/* ── Greeks Momentum Matrix strip ──────────────────────────────── */}
      <MomentumMatrixStrip data={data} />

      {/* ── MIDDLE: Strike Dominance | Futures&Breadth | Session&Risk ─── */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_300px_300px]">
        <StrikeDominancePanel data={data} />
        <FuturesBreadthPanel data={data} />
        <SessionRiskPanel data={data} />
      </div>

      {/* ── FINAL VERDICT bar ─────────────────────────────────────────── */}
      <FinalVerdictBar data={data} tone={verdictTone} />

      <div className="pb-1 text-center text-[10px] uppercase tracking-[0.18em] text-white/35">
        This dashboard is for educational purpose only. Please consult your financial advisor before taking any trading decisions.
      </div>
    </div>
  );
}

/* ═══════════════ PREMIUM INTELLIGENCE PANEL ═══════════════════════════ */
function PremiumIntelligencePanel({ data }: { data: V6Decision }) {
  const g = data.greeks;
  return (
    <div className="rounded-xl border border-white/[0.08] bg-[#0a0e15] p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-[0.20em] text-cyan-300">
          Premium Intelligence
        </span>
        <span className="text-[10px] uppercase tracking-[0.16em] text-white/40">(Greeks Engine)</span>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_1fr_1fr_1fr_220px]">
        <GreekEngineCard
          icon="📐"
          title="DELTA ENGINE"
          big={g.delta.value.toFixed(2)}
          subTrend={g.delta.trend}
          tag={g.delta.verdict}
          tagTone={g.delta.quality === "FAKE" ? "#ef4444" : g.delta.bias === "BULLISH" ? "#22c55e" : "#ef4444"}
          accent="#38bdf8"
        />
        <GreekEngineCard
          icon="⚡"
          title="GAMMA ENGINE"
          big={g.gamma.level}
          bigSize={26}
          sub={g.gamma.index.toFixed(3)}
          tag={g.gamma.verdict}
          tagTone={g.gamma.level === "HIGH" ? "#f59e0b" : g.gamma.level === "MEDIUM" ? "#facc15" : "#94a3b8"}
          accent="#f59e0b"
        />
        <GreekEngineCard
          icon="⏳"
          title="THETA ENGINE"
          big={g.theta.value.toFixed(1)}
          bigTone="#ef4444"
          subStatic={g.theta.level === "FAST" ? "FAST" : g.theta.level === "MEDIUM" ? "MODERATE" : "SLOW"}
          tag={g.theta.verdict}
          tagTone={g.theta.level === "FAST" ? "#ef4444" : g.theta.level === "MEDIUM" ? "#f59e0b" : "#22c55e"}
          accent="#f59e0b"
        />
        <GreekEngineCard
          icon="🌪"
          title="VEGA ENGINE"
          big={g.vega.value.toFixed(2)}
          subTrend={g.vega.trend === "RISING" ? "RISING" : g.vega.trend === "FALLING" ? "FALLING" : "FLAT"}
          tag={g.vega.verdict}
          tagTone={g.vega.state === "EXPANDING" ? "#22c55e" : g.vega.state === "CRUSH" ? "#ef4444" : "#94a3b8"}
          accent="#22d3ee"
        />
        <PremiumPowerGauge data={data} />
      </div>
    </div>
  );
}

/* ── Single Greek engine card ──────────────────────────────────────── */
function GreekEngineCard({
  icon, title, big, bigSize = 32, bigTone, sub, subTrend, subStatic, tag, tagTone, accent,
}: {
  icon: string;
  title: string;
  big: string;
  bigSize?: number;
  bigTone?: string;
  sub?: string;
  subTrend?: string;
  subStatic?: string;
  tag: string;
  tagTone: string;
  accent: string;
}) {
  const trendUp = subTrend === "RISING";
  const trendDown = subTrend === "FALLING";
  return (
    <div className="flex flex-col rounded-lg border border-white/[0.07] bg-white/[0.02] p-2.5">
      <div className="mb-1 flex items-center gap-1.5">
        <span className="text-[13px]">{icon}</span>
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-white/65">{title}</span>
      </div>
      <div
        className="font-mono font-black leading-none"
        style={{ fontSize: bigSize, color: bigTone || "#e8fbff" }}
      >
        {big}
      </div>
      <div className="mt-1 flex h-4 items-center gap-1 text-[11px] font-bold uppercase tracking-wider">
        {subTrend ? (
          <span style={{ color: trendUp ? "#22c55e" : trendDown ? "#ef4444" : "#94a3b8" }}>
            {subTrend} {trendUp ? "↑" : trendDown ? "↓" : "→"}
          </span>
        ) : subStatic ? (
          <span className="text-white/65">{subStatic}</span>
        ) : sub ? (
          <span className="font-mono text-white/55">{sub}</span>
        ) : null}
      </div>
      <div
        className="mt-2 rounded-md border px-2 py-1.5 text-center text-[11px] font-black uppercase tracking-wider"
        style={{ borderColor: `${tagTone}66`, background: `${tagTone}1a`, color: tagTone }}
      >
        {tag}
      </div>
      <div className="mt-1 h-0.5 w-full rounded-full" style={{ background: `${accent}55` }} />
    </div>
  );
}

/* ── Premium Power Score gauge (half-ring) ─────────────────────────── */
function PremiumPowerGauge({ data }: { data: V6Decision }) {
  const score = data.premiumPower.score;
  const v = Math.max(0, Math.min(100, score));
  // semicircle gauge
  const R = 52;
  const cx = 70;
  const cy = 64;
  const startAngle = Math.PI; // 180deg
  const endAngle = 0;
  const angle = startAngle + (endAngle - startAngle) * (v / 100);
  const pt = (a: number, r: number) => ({ x: cx + r * Math.cos(a), y: cy - r * Math.sin(a) });
  const arcPath = (a0: number, a1: number, r: number) => {
    const p0 = pt(a0, r);
    const p1 = pt(a1, r);
    const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
    const sweep = a1 < a0 ? 1 : 0;
    return `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${large} ${sweep} ${p1.x} ${p1.y}`;
  };
  const tone = data.premiumPower.state === "AVOID" || data.premiumPower.state === "LOW EDGE"
    ? "#ef4444"
    : data.premiumPower.state === "TRADEABLE"
      ? "#facc15"
      : "#22c55e";
  const needle = pt(angle, R - 6);

  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-emerald-400/30 bg-emerald-400/[0.04] p-2">
      <span className="mb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-white/65">
        Premium Power Score
      </span>
      <div className="relative h-[78px] w-[140px]">
        <svg viewBox="0 0 140 74" className="h-full w-full">
          {/* track */}
          <path d={arcPath(startAngle, endAngle, R)} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="9" strokeLinecap="round" />
          {/* red→amber→green segments under value */}
          <path d={arcPath(startAngle, angle, R)} fill="none" stroke={tone} strokeWidth="9" strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 4px ${tone}88)`, transition: "all .5s ease" }} />
          {/* needle */}
          <line x1={cx} y1={cy} x2={needle.x} y2={needle.y} stroke="#e8fbff" strokeWidth="2" />
          <circle cx={cx} cy={cy} r="3.5" fill="#e8fbff" />
        </svg>
        <div className="absolute inset-x-0 top-3 flex flex-col items-center">
          <span className="font-mono text-[30px] font-black leading-none" style={{ color: tone }}>
            {v}
          </span>
          <span className="text-[9px] font-bold uppercase tracking-wider text-white/45">/100</span>
        </div>
      </div>
      <span className="mt-0.5 text-[9px] font-bold uppercase tracking-[0.16em] text-white/45">State</span>
      <span className="text-center text-[12px] font-black uppercase leading-tight" style={{ color: tone }}>
        {data.premiumPower.state}
      </span>
    </div>
  );
}

/* ═══════════════ ACTION PLAN CARD ═════════════════════════════════════ */
function ActionPlanCard({ data }: { data: V6Decision }) {
  const ap = data.actionPlan;
  const tone = toneFor(ap.marketBias);
  const arrow = ap.marketBias === "BULLISH" ? "↗" : ap.marketBias === "BEARISH" ? "↘" : "→";
  return (
    <div className="rounded-xl border-2 bg-[#0a0e15] p-3" style={{ borderColor: `${tone}55` }}>
      <div className="text-center">
        <div className="text-[12px] font-bold uppercase tracking-[0.16em] text-white/85">
          Option Buyer Action Plan
        </div>
        <div className="text-[10px] uppercase tracking-[0.14em] text-white/45">{ap.setup}</div>
      </div>

      <div className="mt-3 rounded-lg border bg-black/20 p-3" style={{ borderColor: `${tone}66` }}>
        <div className="text-center text-[10px] font-bold uppercase tracking-[0.18em] text-white/55">Action</div>
        <div className="text-center font-mono text-[40px] font-black leading-none" style={{ color: tone, textShadow: `0 0 16px ${tone}44` }}>
          {ap.action}
        </div>

        <div className="my-2.5 h-px w-full bg-white/10" />

        <div className="text-center text-[10px] font-bold uppercase tracking-[0.18em] text-white/55">Market Bias</div>
        <div className="flex items-center justify-center gap-2 text-[22px] font-black uppercase" style={{ color: tone }}>
          {ap.marketBias} <span>{arrow}</span>
        </div>

        <div className="my-2.5 h-px w-full bg-white/10" />

        <div className="text-center text-[10px] font-bold uppercase tracking-[0.18em] text-white/55">Confidence</div>
        <div className="flex items-center justify-center gap-2">
          <Stars value={ap.confidence} />
          <span className="font-mono text-[15px] font-bold text-white/85">{ap.confidence.toFixed(1)} / 5</span>
        </div>
      </div>
    </div>
  );
}

function Stars({ value }: { value: number }) {
  const full = Math.floor(value);
  const frac = value - full;
  return (
    <div className="flex items-center gap-0.5">
      {[0, 1, 2, 3, 4].map((i) => {
        const fill = i < full ? 1 : i === full ? frac : 0;
        return (
          <span key={i} className="relative text-[18px] leading-none">
            <span className="text-white/20">★</span>
            <span
              className="absolute inset-0 overflow-hidden text-amber-400"
              style={{ width: `${fill * 100}%` }}
            >
              ★
            </span>
          </span>
        );
      })}
    </div>
  );
}

/* ═══════════════ GREEKS SUMMARY CARD (right rail) ═════════════════════ */
function GreeksSummaryCard({ data }: { data: V6Decision }) {
  const s = data.greeksSummary;
  const rows: Array<{ label: string; value: string; tone: string; arrow?: string }> = [
    { label: "Delta Trend", value: s.deltaTrend, tone: trendTone(s.deltaTrend), arrow: s.deltaTrend === "RISING" ? "↑" : s.deltaTrend === "FALLING" ? "↓" : "→" },
    { label: "Gamma Level", value: s.gammaLevel, tone: s.gammaLevel === "HIGH" ? "#22c55e" : s.gammaLevel === "MEDIUM" ? "#facc15" : "#94a3b8" },
    { label: "Theta Impact", value: s.thetaImpact, tone: s.thetaImpact === "LOW" ? "#22c55e" : s.thetaImpact === "MEDIUM" ? "#facc15" : "#ef4444" },
    { label: "Vega Trend", value: s.vegaTrend, tone: s.vegaTrend === "EXPANDING" ? "#22c55e" : s.vegaTrend === "CRUSH" ? "#ef4444" : "#94a3b8" },
    { label: "Premium Edge", value: s.premiumEdge, tone: s.premiumEdge === "HIGH" ? "#22c55e" : s.premiumEdge === "MEDIUM" ? "#facc15" : "#ef4444" },
  ];
  return (
    <div className="rounded-xl border border-white/[0.08] bg-[#0a0e15] p-3">
      <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-white/85">Greeks Summary</div>
      <div className="flex flex-col">
        {rows.map((r, i) => (
          <div
            key={r.label}
            className={`flex items-center justify-between py-2 ${i < rows.length - 1 ? "border-b border-white/[0.06]" : ""}`}
          >
            <span className="text-[12px] uppercase tracking-wide text-white/55">{r.label}</span>
            <span className="text-[13px] font-black uppercase tracking-wider" style={{ color: r.tone }}>
              {r.value} {r.arrow || ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════ GREEKS MOMENTUM MATRIX STRIP ═════════════════════════ */
function MomentumMatrixStrip({ data }: { data: V6Decision }) {
  const m = data.momentumMatrix;
  const cells: Array<{ value: string; tone: string; arrow: string }> = [
    { value: m.delta.label === "STRONG" ? "Strong" : m.delta.label === "MODERATE" ? "Moderate" : "Weak", tone: trendTone(m.delta.trend), arrow: m.delta.trend === "RISING" ? "↑" : m.delta.trend === "FALLING" ? "↓" : "→" },
    { value: m.gamma.label === "HIGH" ? "Gaining" : m.gamma.label === "MEDIUM" ? "Steady" : "Soft", tone: m.gamma.label === "HIGH" ? "#22c55e" : m.gamma.label === "MEDIUM" ? "#facc15" : "#94a3b8", arrow: m.gamma.trend === "RISING" ? "↑" : m.gamma.trend === "FALLING" ? "↓" : "→" },
    { value: m.theta.label === "FAST" ? "Decay" : m.theta.label === "MEDIUM" ? "Decay" : "Slow", tone: m.theta.label === "FAST" ? "#ef4444" : m.theta.label === "MEDIUM" ? "#f59e0b" : "#22c55e", arrow: "↓" },
    { value: m.vega.label === "EXPANDING" ? "Expanding" : m.vega.label === "CRUSH" ? "Crushing" : "Stable", tone: m.vega.label === "EXPANDING" ? "#22c55e" : m.vega.label === "CRUSH" ? "#ef4444" : "#94a3b8", arrow: m.vega.trend === "RISING" ? "↑" : m.vega.trend === "FALLING" ? "↓" : "→" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-2 rounded-xl border border-white/[0.08] bg-[#0a0e15] px-4 py-2.5">
      <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-white/65">Greeks Momentum Matrix</span>
      {cells.map((c, i) => (
        <span key={i} className="text-[13px] font-black uppercase tracking-wider" style={{ color: c.tone }}>
          {c.value} {c.arrow}
        </span>
      ))}
      <div className="ml-auto flex items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-white/55">Momentum Score</span>
        <span className="font-mono text-[18px] font-black text-cyan-300">{m.score}</span>
        <span className="text-[11px] text-white/45">/ 100</span>
      </div>
    </div>
  );
}

/* ═══════════════ STRIKE DOMINANCE PANEL (ATM ± 5) ═════════════════════ */
function StrikeDominancePanel({ data }: { data: V6Decision }) {
  const sd = data.strikeDominance;
  return (
    <div className="rounded-xl border border-white/[0.08] bg-[#0a0e15] p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-cyan-300">
          Strike Dominance — ATM ± 5
        </span>
        <span className="text-[10px] uppercase tracking-[0.14em] text-white/45">
          {sd.count} Strikes · {sd.step} Step
        </span>
      </div>
      {sd.strikes.length === 0 ? (
        <div className="py-6 text-center text-[12px] text-white/40">No strike data in window</div>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {sd.strikes.map((s) => (
            <StrikeCard key={s.strike} row={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function StrikeCard({ row }: { row: V6StrikeRow }) {
  const sideTone = row.side === "ATM" ? "#f59e0b" : row.side === "CE" ? "#22c55e" : "#ef4444";
  const labelTone = row.label.startsWith("STRONG CE") ? "#22c55e"
    : row.label.startsWith("STRONG PE") ? "#ef4444"
    : row.label === "ATM ZONE" ? "#f59e0b"
    : row.side === "CE" ? "#22c55e" : "#ef4444";
  return (
    <div
      className="flex min-w-[120px] flex-1 flex-col rounded-lg border-2 bg-white/[0.02] p-2"
      style={{ borderColor: row.isAtm ? "#f59e0b88" : "rgba(255,255,255,0.08)" }}
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-[16px] font-black text-white/95">{row.strike}</span>
        <span className="text-[10px] font-black uppercase tracking-wider" style={{ color: sideTone }}>
          {row.side}
        </span>
      </div>

      {/* CE vs PE favour split bar */}
      <div className="mt-2 flex items-center justify-between text-[11px] font-bold">
        <span className="text-emerald-400">{row.ceFavorPct}%</span>
        <span className="text-rose-400">{row.peFavorPct}%</span>
      </div>
      <div className="mt-0.5 flex h-2 w-full overflow-hidden rounded-full bg-white/10">
        <div className="h-full bg-emerald-500" style={{ width: `${row.ceFavorPct}%` }} />
        <div className="h-full bg-rose-500" style={{ width: `${row.peFavorPct}%` }} />
      </div>

      {/* OI + change */}
      <div className="mt-2 text-[10px] text-white/55">
        OI {fmtOiCompact(row.oi)}{" "}
        <span style={{ color: row.oiChangePct >= 0 ? "#22c55e" : "#ef4444" }}>
          {row.oiChangePct >= 0 ? "+" : ""}{row.oiChangePct}%
        </span>
      </div>

      <div
        className="mt-1.5 rounded border px-1.5 py-1 text-center text-[10px] font-black uppercase tracking-wider"
        style={{ borderColor: `${labelTone}55`, background: `${labelTone}18`, color: labelTone }}
      >
        {row.label}
      </div>
    </div>
  );
}

/* ═══════════════ FUTURES & BREADTH PANEL ══════════════════════════════ */
function FuturesBreadthPanel({ data }: { data: V6Decision }) {
  const fb = data.futuresBreadth;
  const futTone = fb.futPremium >= 0 ? "#22c55e" : "#ef4444";
  const sentTone = toneFor(fb.sentiment);
  const advTotal = fb.advDec.adv + fb.advDec.dec || 1;
  const advRatio = Math.round((fb.advDec.adv / advTotal) * 100);
  return (
    <div className="rounded-xl border border-white/[0.08] bg-[#0a0e15] p-3">
      <div className="mb-2 text-center text-[11px] font-bold uppercase tracking-[0.16em] text-sky-300">
        Futures &amp; Breadth
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-white/45">Futures Premium</div>
          <div className="font-mono text-[24px] font-black leading-none" style={{ color: futTone }}>
            {fb.futPremium >= 0 ? "+" : ""}{fb.futPremium.toFixed(2)}
          </div>
          <div className="mt-1 text-[10px] font-bold uppercase tracking-wide" style={{ color: futTone }}>
            {fb.premiumState}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wide text-white/45">Adv / Dec</div>
          <div className="font-mono text-[18px] font-black leading-none">
            <span className="text-emerald-400">{fb.advDec.adv}</span>
            <span className="text-white/30"> / </span>
            <span className="text-rose-400">{fb.advDec.dec}</span>
          </div>
          <div className="mt-1 text-[10px] font-bold uppercase tracking-wide text-white/55">{fb.advDec.label}</div>
        </div>
      </div>

      {/* adv/dec bar */}
      <div className="mt-2 flex h-2 w-full overflow-hidden rounded-full bg-white/10">
        <div className="h-full bg-emerald-500" style={{ width: `${advRatio}%` }} />
        <div className="h-full bg-rose-500" style={{ width: `${100 - advRatio}%` }} />
      </div>

      <div className="my-3 h-px w-full bg-white/10" />

      <div className="text-[10px] uppercase tracking-wide text-white/45">Market Sentiment</div>
      <div className="flex items-center gap-2 text-[24px] font-black uppercase" style={{ color: sentTone }}>
        {fb.sentiment}
        <span>{fb.sentiment === "BULLISH" ? "🐂" : fb.sentiment === "BEARISH" ? "🐻" : "•"}</span>
      </div>
    </div>
  );
}

/* ═══════════════ SESSION & RISK PANEL ═════════════════════════════════ */
function SessionRiskPanel({ data }: { data: V6Decision }) {
  const ses = data.session;
  const risk = data.risk;
  const riskTone = risk.level === "LOW" ? "#22c55e" : risk.level === "MEDIUM" ? "#facc15" : "#ef4444";
  const rewardTone = risk.reward === "HIGH" ? "#22c55e" : risk.reward === "MEDIUM" ? "#facc15" : "#ef4444";
  const volTone = ses.volatility === "LOW" ? "#22c55e" : ses.volatility === "MEDIUM" || ses.volatility === "MODERATE" ? "#facc15" : "#ef4444";
  return (
    <div className="rounded-xl border border-white/[0.08] bg-[#0a0e15] p-3">
      <div className="mb-2 text-center text-[11px] font-bold uppercase tracking-[0.16em] text-white/85">
        Session &amp; Risk
      </div>

      <div className="grid grid-cols-3 gap-2 border-b border-white/[0.06] pb-3">
        <MiniStat label="Day" value={ses.day} />
        <MiniStat label="Time" value={ses.time} />
        <MiniStat label="Volatility" value={ses.volatility} tone={volTone} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="flex flex-col items-center gap-1 rounded-lg border border-white/[0.07] bg-white/[0.02] py-3">
          <span className="text-[10px] uppercase tracking-wide text-white/45">Risk Level</span>
          <span className="text-[20px] font-black uppercase" style={{ color: riskTone }}>{risk.level}</span>
          <span className="text-[14px]">🛡</span>
        </div>
        <div className="flex flex-col items-center gap-1 rounded-lg border border-white/[0.07] bg-white/[0.02] py-3">
          <span className="text-[10px] uppercase tracking-wide text-white/45">Reward Potential</span>
          <span className="text-[20px] font-black uppercase" style={{ color: rewardTone }}>{risk.reward}</span>
          <span className="text-[14px]">🚀</span>
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col items-center">
      <span className="text-[9px] uppercase tracking-wide text-white/45">{label}</span>
      <span className="text-[13px] font-black uppercase" style={{ color: tone || "#e8fbff" }}>{value}</span>
    </div>
  );
}

/* ═══════════════ FINAL VERDICT BAR ════════════════════════════════════ */
function FinalVerdictBar({ data, tone }: { data: V6Decision; tone: string }) {
  const edge = data.verdict.tradeEdge;
  const edgeTone = edge === "STRONG" ? "#22c55e" : edge === "MODERATE" ? "#facc15" : "#ef4444";
  return (
    <div
      className="grid grid-cols-1 items-center gap-3 rounded-xl border-2 bg-[#0a0e15] px-5 py-3 lg:grid-cols-[1fr_auto]"
      style={{ borderColor: `${tone}55` }}
    >
      <div className="text-center lg:text-left">
        <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/45">Final Verdict</div>
        <div className="text-[15px] font-black uppercase tracking-wide text-white/85">{data.verdict.line}</div>
        <div className="mt-0.5 flex items-center justify-center gap-2 lg:justify-start">
          <span className="text-[18px]">{data.actionPlan.marketBias === "BULLISH" ? "🐂" : data.actionPlan.marketBias === "BEARISH" ? "🐻" : "•"}</span>
          <span className="text-[18px] font-black uppercase tracking-wide" style={{ color: tone }}>
            {data.verdict.headline}
          </span>
        </div>
      </div>
      <div className="flex items-center justify-center gap-3 rounded-lg border px-5 py-2" style={{ borderColor: `${edgeTone}55`, background: `${edgeTone}12` }}>
        <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-white/55">Trade Edge</span>
        <span className="flex items-center gap-1 text-[22px] font-black uppercase" style={{ color: edgeTone }}>
          💎 {edge}
        </span>
      </div>
    </div>
  );
}

/* ─── helpers ─────────────────────────────────────────────────────── */
function toneFor(bias: string): string {
  return bias === "BULLISH" ? "#22c55e" : bias === "BEARISH" ? "#ef4444" : "#facc15";
}
function trendTone(t: string): string {
  return t === "RISING" ? "#22c55e" : t === "FALLING" ? "#ef4444" : "#94a3b8";
}
function fmtOiCompact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)} K`;
  return `${Math.round(n)}`;
}
function todayIST(): string {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
}
