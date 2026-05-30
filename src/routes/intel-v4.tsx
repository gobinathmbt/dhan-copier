import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { isAuthenticated } from "@/lib/auth";
import { useIntelV4Decision } from "@/hooks/useIntelV4Decision";
import type { V4Symbol, V4Strike, V4Decision } from "@/lib/intelV4Types";

export const Route = createFileRoute("/intel-v4")({
  component: IntelV4Page,
});

function IntelV4Page() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!isAuthenticated()) navigate({ to: "/login" });
  }, [navigate]);

  const [symbol, setSymbol] = useState<V4Symbol>("NIFTY_50");
  const [date, setDate] = useState<string | null>(null);

  const { data, loading, lastFetchAt, refetch } = useIntelV4Decision({
    symbol,
    date,
    intervalMs: 3000,
  });

  const o = data?.overall;
  const verdictTone =
    o?.verdict === "BUY CE" ? "#22c55e"
    : o?.verdict === "BUY PE" ? "#ef4444"
    : "#facc15";

  return (
    <div className="fixed inset-0 left-16 flex flex-col bg-[#070a0e] font-mono text-white">
      {/* HEADER */}
      <header className="flex items-center justify-between border-b border-white/[0.08] bg-[#0a0d12] px-5 py-3">
        <div className="flex items-center gap-4">
          <span className="text-[15px] font-bold tracking-[0.18em] text-emerald-400">
            INTEL <span className="rounded-sm bg-emerald-400/15 px-2 py-0.5 text-[12px]">V4</span>
          </span>
          <span className="text-[11px] uppercase tracking-wider text-white/45">
            Pure Buyers/Sellers Decision Engine
          </span>
        </div>
        <div className="flex items-center gap-3">
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
            onChange={(e) => {
              const v = e.target.value;
              setDate(v === todayIST() ? null : v);
            }}
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
            className="rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-[12px] text-white/65 hover:bg-white/10 hover:text-white disabled:opacity-50"
          >
            {loading ? "…" : "↻"}
          </button>
          <span className="text-[10px] text-white/45">
            {lastFetchAt ? `${Math.round((Date.now() - lastFetchAt) / 1000)}s ago` : "—"}
          </span>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
        {!data ? (
          <div className="flex h-full items-center justify-center text-[14px] text-white/45">
            Loading V4 decision engine…
          </div>
        ) : !data.ok ? (
          <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-6 text-rose-300">
            <div className="text-[13px] font-bold uppercase tracking-wider">Engine Error</div>
            <div className="mt-2 text-[12px]">{(data as unknown as { error?: string }).error || "Unable to load."}</div>
          </div>
        ) : (
          <>
            {/* ─── HERO VERDICT ROW ─────────────────────────────────── */}
            <section
              className="grid grid-cols-[1fr_auto_1fr] items-center gap-6 rounded-md border px-6 py-5"
              style={{
                borderColor: `${verdictTone}55`,
                background: `linear-gradient(135deg, ${verdictTone}10 0%, transparent 60%)`,
              }}
            >
              {/* LEFT — Verdict + strike */}
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-bold uppercase tracking-[0.20em] text-white/55">
                  Verdict
                </span>
                <span
                  className="text-[48px] font-black leading-none tracking-tight"
                  style={{ color: verdictTone }}
                >
                  {o?.verdict}
                </span>
                {data.bestStrike ? (
                  <span className="mt-1 text-[16px] font-bold" style={{ color: verdictTone }}>
                    Best strike: {data.bestStrike.strike} {data.bestStrike.side}
                  </span>
                ) : null}
                <span className="text-[11px] text-white/55">{data.bestStrike?.reason || "—"}</span>
              </div>

              {/* CENTER — Conviction + grade */}
              <div className="flex flex-col items-center gap-1.5">
                <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/55">
                  Conviction
                </span>
                <span className="text-[64px] font-black leading-none" style={{ color: verdictTone }}>
                  {o?.grade}
                </span>
                <span className="text-[12px] font-bold uppercase tracking-[0.16em]" style={{ color: verdictTone }}>
                  {o?.conviction}
                </span>
                <span className="text-[10px] text-white/45">
                  {o?.confidence}% confidence
                </span>
              </div>

              {/* RIGHT — control + direction */}
              <div className="flex flex-col items-end gap-1">
                <span className="text-[10px] font-bold uppercase tracking-[0.20em] text-white/55">
                  Market Control
                </span>
                <span
                  className="text-[28px] font-black uppercase tracking-tight"
                  style={{ color: o?.control === "BUYERS" ? "#22c55e" : o?.control === "SELLERS" ? "#ef4444" : "#facc15" }}
                >
                  {o?.control}
                </span>
                <span className="text-[10px] font-bold uppercase tracking-wider text-white/55">
                  Likely Direction
                </span>
                <span
                  className="text-[20px] font-black"
                  style={{ color: o?.directionLikely === "UP" ? "#22c55e" : o?.directionLikely === "DOWN" ? "#ef4444" : "#facc15" }}
                >
                  {o?.directionLikely === "UP" ? "↑ UP" : o?.directionLikely === "DOWN" ? "↓ DOWN" : "→ RANGE"}
                </span>
              </div>
            </section>

            {/* ─── SUMMARY METRICS STRIP ────────────────────────────── */}
            <section className="grid grid-cols-6 gap-2 text-[12px]">
              <Metric label="Spot" value={data.spotPrice.toFixed(2)} />
              <Metric label="VWAP" value={data.vwap.toFixed(2)} />
              <Metric label="Primary Strike" value={String(data.primaryStrike)} highlight />
              <Metric
                label="Bull / Bear Strikes"
                value={`${o?.bullVotes ?? 0} / ${o?.bearVotes ?? 0}`}
                tone={(o?.bullVotes ?? 0) > (o?.bearVotes ?? 0) ? "bull" : (o?.bearVotes ?? 0) > (o?.bullVotes ?? 0) ? "bear" : "neutral"}
              />
              <Metric
                label="Bull Flow"
                value={`${o?.bullishFlowPct ?? 0}%`}
                tone={(o?.bullishFlowPct ?? 50) >= 60 ? "bull" : (o?.bullishFlowPct ?? 50) <= 40 ? "bear" : "neutral"}
              />
              <Metric
                label="Most Volume"
                value={data.mostVolume?.strike ? String(data.mostVolume.strike) : "—"}
              />
            </section>

            {/* ─── CE / PE PRESSURE GAUGE + OI TREND ──────────────────── */}
            <section className="grid grid-cols-[1.4fr_1fr] gap-3">
              {/* Pressure gauge */}
              {data.pressure ? (
                <PressureGauge p={data.pressure} />
              ) : <div />}
              {/* OI trend block + S/R */}
              <div className="flex flex-col gap-2">
                {data.oiTrend ? <OiTrendCard t={data.oiTrend} /> : null}
                {data.supportResistance ? <SupportResistanceCard sr={data.supportResistance} /> : null}
              </div>
            </section>

            {/* ─── REASONS ───────────────────────────────────────────── */}
            {/* {o?.reasons && o.reasons.length > 0 ? (
              <section className="rounded-md border border-white/[0.08] bg-white/[0.02] px-4 py-3">
                <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-white/55">
                  Why
                </div>
                <ul className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12px] text-white/80">
                  {o.reasons.map((r, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="mt-0.5 text-sky-300">▸</span>
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null} */}

            {/* ─── PER-STRIKE CARDS (ATM ± dynamic window) ────────────
                Each strike rendered as its own info-dense card.
                ATM card highlighted in sky-blue.
                S/R walls highlighted with green/red borders + WALL badges.
                Window expands beyond ATM ± 5 if a major wall sits outside. */}
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/65">
                  Strike Domination — ATM {data.window?.expanded ? `±${Math.max(data.window.above, data.window.below)} (expanded)` : "± 5"}
                </span>
                <span className="text-[10px] text-white/45">
                  {data.strikes.length} strikes · 100-step grid
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-4">
                {data.strikes.map((s) => (
                  <StrikeCard key={s.strike} s={s} />
                ))}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * StrikeCard — single-strike info card.
 * Layout: header (strike + impact) → CE/PE side-by-side → footer note.
 * ATM card highlighted sky-blue.
 * S/R walls highlighted with green (support) / red (resistance) accent
 * and a SUPPORT / RESISTANCE badge. Top wall (tierIdx 0) gets a glow.
 * ───────────────────────────────────────────────────────────────────── */
function StrikeCard({ s }: { s: V4Strike }) {
  const isWall = !!s.wall;
  const isTopWall = isWall && s.wall!.tierIdx === 0;
  const wallType = s.wall?.type;

  // Border + background priority: ATM > top-wall > wall > impact > neutral
  const accent =
    s.isAtm ? "#38bdf8"
    : isTopWall && wallType === "RESISTANCE" ? "#ef4444"
    : isTopWall && wallType === "SUPPORT" ? "#22c55e"
    : isWall && wallType === "RESISTANCE" ? "#fda4af"
    : isWall && wallType === "SUPPORT" ? "#86efac"
    : s.marketImpact === "BULLISH" ? "#22c55e"
    : s.marketImpact === "BEARISH" ? "#ef4444"
    : "rgba(255,255,255,0.18)";
  const bg =
    s.isAtm ? "rgba(56,189,248,0.10)"
    : isWall && wallType === "RESISTANCE" ? "rgba(239,68,68,0.07)"
    : isWall && wallType === "SUPPORT" ? "rgba(34,197,94,0.07)"
    : s.marketImpact === "BULLISH" ? "rgba(34,197,94,0.05)"
    : s.marketImpact === "BEARISH" ? "rgba(239,68,68,0.05)"
    : "rgba(255,255,255,0.02)";
  const glow = isTopWall ? `0 0 18px ${accent}55, inset 0 0 0 1px ${accent}80` : (s.isAtm ? `inset 0 0 0 1px ${accent}40` : "none");

  const impactColor = s.marketImpact === "BULLISH" ? "#22c55e" : s.marketImpact === "BEARISH" ? "#ef4444" : "#facc15";
  const dominantColor = s.dominantSide === "CE" ? "#22c55e" : s.dominantSide === "PE" ? "#ef4444" : "rgba(255,255,255,0.65)";
  const strengthColor =
    s.strength === "DOMINANT" ? dominantColor :
    s.strength === "STRONG" ? dominantColor :
    s.strength === "MODERATE" ? "#facc15" :
    "rgba(255,255,255,0.45)";

  // Side dominance colors
  const ceTone = s.ce.dominance === "BUYERS" ? "#22c55e" : s.ce.dominance === "SELLERS" ? "#ef4444" : "#facc15";
  const peTone = s.pe.dominance === "BUYERS" ? "#22c55e" : s.pe.dominance === "SELLERS" ? "#ef4444" : "#facc15";

  // Wall badge text
  const wallBadge = (() => {
    if (!isWall) return null;
    const t = wallType === "RESISTANCE" ? "RES" : "SUP";
    return `${t} · ${s.wall!.strength}`;
  })();
  const wallBadgeColor = wallType === "RESISTANCE" ? "#ef4444" : "#22c55e";

  return (
    <div
      className="flex flex-col gap-2 rounded-md border px-3 py-2.5 transition-shadow hover:shadow-[0_0_12px_rgba(56,189,248,0.15)]"
      style={{
        borderColor: `${accent}${isTopWall ? "aa" : "55"}`,
        background: bg,
        boxShadow: glow,
      }}
    >
      {/* HEADER — strike + ATM/wall badge + impact pill */}
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <span
            className="font-mono text-[20px] font-black tabular-nums leading-none"
            style={{ color: s.isAtm ? "#38bdf8" : "rgba(255,255,255,0.95)" }}
          >
            {s.strike}
          </span>
          {s.isAtm ? (
            <span
              className="rounded-sm border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
              style={{ borderColor: "rgba(56,189,248,0.50)", background: "rgba(56,189,248,0.15)", color: "#38bdf8" }}
            >
              ATM
            </span>
          ) : (
            <span className="text-[10px] text-white/45">
              {s.offset > 0 ? `+${s.offset}` : s.offset}
            </span>
          )}
          {wallBadge ? (
            <span
              className="rounded-sm border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
              style={{
                borderColor: `${wallBadgeColor}80`,
                background: `${wallBadgeColor}20`,
                color: wallBadgeColor,
              }}
              title={s.wall!.tier}
            >
              {wallBadge}
            </span>
          ) : null}
        </div>
        <span
          className="rounded-sm px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
          style={{ background: `${impactColor}1a`, color: impactColor }}
        >
          {s.marketImpact}
        </span>
      </div>

      {/* CE / PE side-by-side */}
      <div className="grid grid-cols-2 gap-2">
        <SideBlock label="CE" tone="bull" side={s.ce} accent={ceTone} />
        <SideBlock label="PE" tone="bear" side={s.pe} accent={peTone} />
      </div>

      {/* FOOTER — dominant + strength + note */}
      <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] pt-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] font-bold uppercase tracking-wider text-white/45">DOM</span>
          <span className="text-[12px] font-black uppercase" style={{ color: dominantColor }}>
            {s.dominantSide}
          </span>
          <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: strengthColor }}>
            {s.strength}
          </span>
        </div>
        <span className="truncate text-[10px] text-white/55" title={s.note}>
          {s.note}
        </span>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * SideBlock — single side (CE or PE) in a strike card.
 * Renders Buy% / Sell% bar + buildup tag + OI state.
 * ───────────────────────────────────────────────────────────────────── */
function SideBlock({
  label, tone, side, accent,
}: {
  label: string;
  tone: "bull" | "bear";
  side: V4Strike["ce"];
  accent: string;
}) {
  const labelColor = tone === "bull" ? "#22c55e" : "#ef4444";
  const oiStateColor =
    side.oiState === "STRONG ADD" ? "#22c55e" :
    side.oiState === "ADDING" || side.oiState === "BUILDING" ? "#86efac" :
    side.oiState === "STRONG UNWIND" ? "#ef4444" :
    side.oiState === "UNWINDING" || side.oiState === "EASING" ? "#fda4af" :
    "rgba(255,255,255,0.45)";
  return (
    <div
      className="flex flex-col gap-1 rounded-sm border px-2 py-1.5"
      style={{
        borderColor: `${labelColor}33`,
        background: `${labelColor}08`,
      }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: labelColor }}>
          {label}
        </span>
        <span
          className="text-[9px] font-bold uppercase tracking-wider"
          style={{ color: accent }}
        >
          {side.dominance}
        </span>
      </div>
      {/* Buy / Sell percentages on a single horizontal bar */}
      <div className="flex h-2 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="h-full"
          style={{
            width: `${side.buyersPct}%`,
            background: "rgba(34,197,94,0.85)",
          }}
        />
        <div
          className="h-full"
          style={{
            width: `${side.sellersPct}%`,
            background: "rgba(239,68,68,0.85)",
          }}
        />
      </div>
      <div className="flex items-center justify-between text-[10px]">
        <span className="font-mono text-emerald-400">B {side.buyersPct}%</span>
        <span className="font-mono text-rose-400">S {side.sellersPct}%</span>
      </div>
      <div className="flex items-center justify-between gap-1">
        <span className="truncate text-[10px] text-white/65" title={side.buildup}>
          {side.buildup === "—" ? "no data" : side.buildup}
        </span>
        {side.oiState && side.oiState !== "—" ? (
          <span className="shrink-0 text-[9px] font-bold uppercase tracking-wider" style={{ color: oiStateColor }} title="Change in OI state">
            {side.oiState}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * PressureGauge — twin half-circle 180° meter for CE / PE pressure.
 * Tilt = cePressure - pePressure (-100..+100). Needle reflects the tilt.
 * ───────────────────────────────────────────────────────────────────── */
function PressureGauge({ p }: { p: NonNullable<V4Decision["pressure"]> }) {
  const tiltColor =
    p.tilt >= 40 ? "#22c55e" :
    p.tilt >= 15 ? "#86efac" :
    p.tilt <= -40 ? "#ef4444" :
    p.tilt <= -15 ? "#fda4af" :
    "#facc15";
  // Map tilt -100..+100 to needle angle 180° (left = bear) → 0° (right = bull)
  // 0 tilt = 90° (top center)
  const angle = 180 - ((p.tilt + 100) / 200) * 180;
  const radians = ((angle - 180) * Math.PI) / 180;
  const r = 90;
  const cx = 100, cy = 100;
  const nx = cx + 76 * Math.cos(radians);
  const ny = cy + 76 * Math.sin(radians);
  const arcPath = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-white/[0.10] bg-white/[0.02] px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/70">
          CE / PE Pressure Gauge
        </span>
        <span
          className="rounded-sm px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
          style={{ background: `${tiltColor}1a`, color: tiltColor }}
        >
          {p.tiltLabel}
        </span>
      </div>
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4">
        {/* CE pressure */}
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">CE</span>
          <span className="font-mono text-[24px] font-black tabular-nums text-emerald-400">
            {p.cePressure}
          </span>
          <span className="text-[9px] uppercase tracking-wider text-white/45">Pressure</span>
        </div>
        {/* Half-circle gauge */}
        <div className="flex justify-center">
          <svg viewBox="0 0 200 120" className="w-full max-w-[260px]">
            <defs>
              <linearGradient id="gaugeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#ef4444" />
                <stop offset="50%" stopColor="#facc15" />
                <stop offset="100%" stopColor="#22c55e" />
              </linearGradient>
            </defs>
            <path d={arcPath} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="14" />
            <path d={arcPath} fill="none" stroke="url(#gaugeGrad)" strokeWidth="14" strokeLinecap="round" />
            {/* Tick marks at 30deg */}
            {[0, 30, 60, 90, 120, 150, 180].map((t) => {
              const tr = ((t - 180) * Math.PI) / 180;
              const x1 = cx + (r - 10) * Math.cos(tr);
              const y1 = cy + (r - 10) * Math.sin(tr);
              const x2 = cx + (r + 4) * Math.cos(tr);
              const y2 = cy + (r + 4) * Math.sin(tr);
              return <line key={t} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(255,255,255,0.30)" strokeWidth="1.4" />;
            })}
            {/* Needle */}
            <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#ffffff" strokeWidth="3" strokeLinecap="round"
              style={{ filter: `drop-shadow(0 0 5px ${tiltColor})`, transition: "all 0.5s ease" }} />
            <circle cx={cx} cy={cy} r="6" fill={tiltColor} />
            <circle cx={cx} cy={cy} r="3" fill="#0e1117" />
          </svg>
        </div>
        {/* PE pressure */}
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-rose-400">PE</span>
          <span className="font-mono text-[24px] font-black tabular-nums text-rose-400">
            {p.pePressure}
          </span>
          <span className="text-[9px] uppercase tracking-wider text-white/45">Pressure</span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] pt-2 text-[11px]">
        <span className="text-white/55">Activity Intensity</span>
        <span className="font-bold uppercase tracking-wider" style={{
          color: p.intensity === "EXTREME" ? "#ef4444" : p.intensity === "HIGH" ? "#facc15" : p.intensity === "MODERATE" ? "#86efac" : "rgba(255,255,255,0.55)",
        }}>
          {p.intensity} ({p.intensityPct}% OI churn)
        </span>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * OiTrendCard — aggregate change-in-OI across the visible window.
 * Shows CE OI added vs PE OI added + the four-quadrant narrative.
 * ───────────────────────────────────────────────────────────────────── */
function OiTrendCard({ t }: { t: NonNullable<V4Decision["oiTrend"]> }) {
  const tone = t.bias === "BULLISH" ? "#22c55e" : t.bias === "BEARISH" ? "#ef4444" : "#facc15";
  const fmtOi = (n: number) => {
    const a = Math.abs(n);
    if (a >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
    if (a >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
    if (a >= 1e3) return `${(n / 1e3).toFixed(1)} K`;
    return `${Math.round(n)}`;
  };
  return (
    <div className="flex flex-col gap-2 rounded-md border border-white/[0.10] bg-white/[0.02] px-3 py-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/70">
          OI Trend Analysis
        </span>
        <span
          className="rounded-sm px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
          style={{ background: `${tone}1a`, color: tone }}
        >
          {t.bias}
        </span>
      </div>
      {/* CE vs PE OI added bar */}
      <div className="flex h-2.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div className="h-full" style={{ width: `${t.ceShare}%`, background: "rgba(34,197,94,0.85)" }} />
        <div className="h-full" style={{ width: `${t.peShare}%`, background: "rgba(239,68,68,0.85)" }} />
      </div>
      <div className="flex justify-between text-[10px]">
        <span className="font-mono text-emerald-400">CE +{fmtOi(t.ceOiAdded)} ({t.ceShare}%)</span>
        <span className="font-mono text-rose-400">PE +{fmtOi(t.peOiAdded)} ({t.peShare}%)</span>
      </div>
      <div className="rounded-sm border px-2 py-1 text-[11px] font-bold uppercase tracking-wider" style={{ borderColor: `${tone}55`, color: tone, background: `${tone}10` }}>
        {t.narrative} · Price {t.priceDirection === "UP" ? "↑" : "↓"}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * SupportResistanceCard — top wall on each side within the visible window.
 * ───────────────────────────────────────────────────────────────────── */
function SupportResistanceCard({ sr }: { sr: NonNullable<V4Decision["supportResistance"]> }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-white/[0.10] bg-white/[0.02] px-3 py-2">
      <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/70">
        Support / Resistance Walls
      </span>
      {sr.topResistance ? (
        <WallRow type="RESISTANCE" w={sr.topResistance} />
      ) : (
        <div className="text-[10px] text-white/45">No resistance wall in window</div>
      )}
      {sr.topSupport ? (
        <WallRow type="SUPPORT" w={sr.topSupport} />
      ) : (
        <div className="text-[10px] text-white/45">No support wall in window</div>
      )}
    </div>
  );
}

function WallRow({
  type, w,
}: {
  type: "RESISTANCE" | "SUPPORT";
  w: { strike: number; tier: string; oi: number; oiChange: number; strength: "STRONG" | "MODERATE" | "WEAK" };
}) {
  const c = type === "RESISTANCE" ? "#ef4444" : "#22c55e";
  const fmtOi = (n: number) => {
    const a = Math.abs(n);
    if (a >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
    if (a >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
    return `${Math.round(n)}`;
  };
  return (
    <div className="flex items-center justify-between rounded-sm border px-2 py-1" style={{ borderColor: `${c}40`, background: `${c}10` }}>
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: c }}>
          {type}
        </span>
        <span className="font-mono text-[14px] font-black tabular-nums" style={{ color: c }}>
          {w.strike}
        </span>
        <span className="text-[10px] text-white/55">{w.tier}</span>
      </div>
      <div className="flex items-center gap-2 text-[10px]">
        <span className="font-mono text-white/65">OI {fmtOi(w.oi)}</span>
        <span
          className="rounded-sm px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
          style={{ background: `${c}25`, color: c }}
        >
          {w.strength}
        </span>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * Metric — small summary tile in the strip below the hero.
 * ───────────────────────────────────────────────────────────────────── */
function Metric({
  label, value, tone, highlight,
}: {
  label: string;
  value: string;
  tone?: "bull" | "bear" | "neutral";
  highlight?: boolean;
}) {
  const color = tone === "bull" ? "#22c55e" : tone === "bear" ? "#ef4444" : tone === "neutral" ? "#facc15" : highlight ? "#38bdf8" : "rgba(255,255,255,0.95)";
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-2">
      <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/55">{label}</span>
      <span className="font-mono text-[16px] font-black tabular-nums" style={{ color }}>
        {value}
      </span>
    </div>
  );
}

function todayIST(): string {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
}
