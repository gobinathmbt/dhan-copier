import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { isAuthenticated } from "@/lib/auth";
import { useIntelV4Decision } from "@/hooks/useIntelV4Decision";
import type { V4Symbol, V4Strike, V4Decision } from "@/lib/intelV4Types";

export const Route = createFileRoute("/intel-v4")({
  component: IntelV4Page,
});

/**
 * INTEL V4 — Pure Logic · Pure Signal
 * ========================================================================
 * Single-card institutional console. Everything a trader needs in one
 * dense screen — no scrolling, no fancy charts, no clutter.
 *
 * Layout (top → bottom inside one bordered card):
 *   1. Header banner — bull / bear logo + title
 *   2. 4-row Logic block — AVWAP · FRVP · OI BUILDUP · OI CHANGE
 *   3. Strength row — CE % · MARKET donut · PE %
 *   4. Action banner — BUY CE / BUY PE / WAIT + Confidence stars
 *   5. Strike grid — ATM ± 5 (compact 11 cards)
 *   6. Footer — Trend · Breadth · Session · Logic source · Time
 */
function IntelV4Page() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!isAuthenticated()) navigate({ to: "/login" });
  }, [navigate]);

  const [symbol, setSymbol] = useState<V4Symbol>("NIFTY_50");
  const [date, setDate] = useState<string | null>(null);
  const { data, loading, lastFetchAt, refetch } = useIntelV4Decision({
    symbol, date, intervalMs: 3000,
  });

  return (
    <div className="intelv4-root fixed inset-0 left-16 flex flex-col bg-[#070a0e] font-mono text-white">
      {/* Mini header — symbol toggle + date controls only */}
      <header className="flex items-center justify-between border-b border-white/[0.08] bg-[#0a0d12] px-4 py-2">
        <span className="text-[12px] font-bold tracking-[0.18em] text-emerald-400">
          INTEL <span className="rounded-sm bg-emerald-400/15 px-2 py-0.5 text-[11px]">V4</span>
        </span>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md bg-white/[0.04] p-0.5">
            {(["NIFTY_50", "SENSEX"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSymbol(s)}
                className={`rounded px-2.5 py-0.5 text-[11px] font-bold tracking-wider transition-colors ${
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
            className="rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-[11px] text-white/85 outline-none [color-scheme:dark]"
          />
          <button
            onClick={() => setDate(null)}
            className={`rounded px-2 py-0.5 text-[10px] font-bold tracking-wider ${
              !date ? "bg-emerald-500/20 text-emerald-400" : "bg-white/5 text-white/55"
            }`}
          >
            LIVE
          </button>
          <button
            onClick={() => refetch()}
            disabled={loading}
            className="rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-[11px] text-white/65 hover:text-white"
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
          <div className="flex h-full items-center justify-center text-[14px] text-white/45">Loading V4…</div>
        ) : !data.ok ? (
          <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-6 text-rose-300">
            <div className="text-[13px] font-bold uppercase tracking-wider">Engine Error</div>
            <div className="mt-2 text-[12px]">{(data as unknown as { error?: string }).error || "Unable to load."}</div>
          </div>
        ) : (
          <SingleCard data={data} />
        )}
      </main>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * SingleCard — the entire V4 dashboard, one bordered card.
 * ───────────────────────────────────────────────────────────────────── */
function SingleCard({ data }: { data: V4Decision }) {
  const o = data.overall;
  const verdictTone =
    o.verdict === "BUY CE" ? "#22c55e"
    : o.verdict === "BUY PE" ? "#ef4444"
    : "#facc15";

  // 4-Logic rows — read directly from V4 engines + V2 acceptance
  const aboveVwap = data.spotPrice > data.vwap;
  const aboveVwapMin = data.engines?.vwapAcceptance?.sideMin ?? 0;
  const oiTrendNarrative = data.oiTrend?.narrative || "BALANCED OI BUILD";
  const oiTrendBias = data.oiTrend?.bias || "NEUTRAL";
  const oiVel = data.engines?.oiVelocity;

  // Strength %
  const cePct = data.pressure?.cePressure ?? 50;
  const pePct = data.pressure?.pePressure ?? 50;

  // Trend direction
  const trend =
    data.overall.directionLikely === "UP" ? "BULLISH ↑"
    : data.overall.directionLikely === "DOWN" ? "BEARISH ↓"
    : "RANGE →";
  const trendColor =
    data.overall.directionLikely === "UP" ? "#22c55e"
    : data.overall.directionLikely === "DOWN" ? "#ef4444"
    : "#facc15";

  // Confidence stars (0..5)
  const stars = Math.round((o.confidence / 100) * 5);

  // Time formatted as 12-hour
  const time = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });

  return (
    <div
      className="flex w-full flex-col gap-3 rounded-2xl border-2 px-5 py-4 shadow-[0_0_30px_rgba(0,0,0,0.5)]"
      style={{ borderColor: `${verdictTone}88` }}
    >
      {/* ─── 1. HEADER BANNER ──────────────────────────────────────── */}
      <div className="flex items-center justify-center gap-4 border-b border-white/[0.08] pb-2">
        <span className="text-[26px]">🐂</span>
        <div className="flex flex-col items-center">
          <span className="text-[24px] font-black tracking-[0.10em] text-white">
            OPTION BUYER ENGINE
          </span>
          <span className="text-[11px] font-bold uppercase tracking-[0.30em] text-white/55">
            Pure Logic · Pure Signal
          </span>
        </div>
        <span className="text-[26px]">🐻</span>
      </div>

      {/* ─── TOP HALF — 50% LEFT (4-row Logic) + 50% RIGHT (Strength + Action) ─── */}
      <div className="grid grid-cols-2 gap-3">
        {/* LEFT 50% — 4-row Logic block */}
        <div className="flex flex-col gap-1.5 rounded-md border border-white/[0.10] px-3 py-2.5">
          <LogicRow
            n={1}
            icon="📈"
            iconBg="rgba(56,189,248,0.18)"
            iconColor="#38bdf8"
            title="AVWAP"
            subtitle="Market Control"
            bigText={aboveVwap ? "ABOVE AVWAP" : "BELOW AVWAP"}
            bigColor={aboveVwap ? "#22c55e" : "#ef4444"}
            desc={
              aboveVwap
                ? `Price is above VWAP\nBuyers in control${aboveVwapMin >= 5 ? ` · ${Math.round(aboveVwapMin)}m sustained` : ""}`
                : `Price is below VWAP\nSellers in control${aboveVwapMin >= 5 ? ` · ${Math.round(aboveVwapMin)}m sustained` : ""}`
            }
            ok={aboveVwap}
          />
          <LogicRow
            n={2}
            icon="📊"
            iconBg="rgba(168,85,247,0.18)"
            iconColor="#a855f7"
            title="FRVP (POC)"
            subtitle="Value Acceptance"
            bigText={getPocLabel(data)}
            bigColor={getPocColor(data)}
            desc={getPocDesc(data)}
            ok={getPocOk(data)}
          />
          <LogicRow
            n={3}
            icon="OI"
            iconBg="rgba(245,158,11,0.18)"
            iconColor="#f59e0b"
            title="OI BUILDUP"
            subtitle="Position Building"
            bigText={oiTrendNarrative}
            bigColor={oiTrendBias === "BULLISH" ? "#22c55e" : oiTrendBias === "BEARISH" ? "#ef4444" : "#facc15"}
            desc={oiTrendDesc(data)}
            ok={oiTrendBias === "BULLISH"}
          />
          <LogicRow
            n={4}
            icon="📶"
            iconBg="rgba(250,204,21,0.18)"
            iconColor="#facc15"
            title="OI CHANGE"
            subtitle="Aggression"
            bigText={oiVel?.label === "AGGRESSIVE" || oiVel?.label === "STRONG" ? "INCREASING" : oiVel?.label === "NORMAL" ? "STABLE" : "QUIET"}
            bigColor={
              oiVel?.label === "AGGRESSIVE" ? "#22c55e"
              : oiVel?.label === "STRONG" ? "#86efac"
              : oiVel?.label === "NORMAL" ? "#facc15"
              : "rgba(255,255,255,0.55)"
            }
            desc={`OI ${oiVel?.label?.toLowerCase() || "normal"}\n${oiVel?.value ? `${formatCompact(oiVel.value)}/min` : "Pressure unknown"}`}
            ok={oiVel?.label === "AGGRESSIVE" || oiVel?.label === "STRONG"}
          />
        </div>

        {/* RIGHT 50% — Strength row stacked above Action banner */}
        <div className="flex flex-col gap-3">
          {/* Strength */}
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-md border border-white/[0.10] px-3 py-3">
            <div className="flex flex-col items-center gap-1.5">
              <span className="text-[12px] font-bold uppercase tracking-[0.16em] text-emerald-400">CE Strength</span>
              <span className="font-mono text-[42px] font-black leading-none text-emerald-400">{cePct}%</span>
              <div className="h-2 w-full overflow-hidden rounded-full bg-white/[0.08]">
                <div className="h-full rounded-full bg-emerald-500/85" style={{ width: `${cePct}%` }} />
              </div>
              <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/65">Buyer Pressure</span>
            </div>
            <DualDonut bullPct={cePct} bearPct={pePct} verdict={o} />
            <div className="flex flex-col items-center gap-1.5">
              <span className="text-[12px] font-bold uppercase tracking-[0.16em] text-rose-400">PE Strength</span>
              <span className="font-mono text-[42px] font-black leading-none text-rose-400">{pePct}%</span>
              <div className="h-2 w-full overflow-hidden rounded-full bg-white/[0.08]">
                <div className="h-full rounded-full bg-rose-500/85" style={{ width: `${pePct}%` }} />
              </div>
              <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/65">Seller Pressure</span>
            </div>
          </div>

          {/* Action banner */}
          <div
            className="grid flex-1 grid-cols-2 items-center gap-3 rounded-md border-2 px-5 py-3"
            style={{ borderColor: verdictTone, background: `${verdictTone}10` }}
          >
            <div className="flex flex-col items-center">
              <span className="text-[10px] font-bold uppercase tracking-[0.20em] text-white/55">Action</span>
              <div className="flex items-center gap-3">
                <span
                  className="font-mono text-[44px] font-black leading-none tracking-tight"
                  style={{ color: verdictTone, textShadow: `0 0 14px ${verdictTone}66` }}
                >
                  {o.verdict}
                </span>
                <span className="text-[28px]">
                  {o.verdict === "BUY CE" ? "📈" : o.verdict === "BUY PE" ? "📉" : "⏸"}
                </span>
              </div>
              <span className="text-center text-[10px] text-white/55">
                {o.verdict === "BUY CE" ? "Follow the trend with strength"
                  : o.verdict === "BUY PE" ? "Sellers pressing — fade rallies"
                  : "No edge — wait for confirmation"}
              </span>
            </div>
            <div className="flex flex-col items-center border-l border-white/[0.08] pl-3">
              <span className="text-[10px] font-bold uppercase tracking-[0.20em] text-white/55">Confidence</span>
              <span
                className="font-mono text-[36px] font-black leading-none tracking-tight"
                style={{ color: verdictTone, textShadow: `0 0 10px ${verdictTone}66` }}
              >
                {o.conviction}
              </span>
              <div className="mt-1 flex gap-1">
                {Array.from({ length: 5 }).map((_, i) => (
                  <span
                    key={i}
                    className="text-[18px] leading-none"
                    style={{ color: i < stars ? verdictTone : "rgba(255,255,255,0.18)" }}
                  >
                    ★
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ─── BOTTOM HALF — STRIKE GRID full-width ──────────────────── */}
      <div className="flex flex-col gap-2 rounded-md border border-white/[0.10] px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-[14px] font-bold uppercase tracking-[0.18em] text-white/80">
            Strike Domination — ATM {data.window?.expanded ? `±${Math.max(data.window.above, data.window.below)}` : "± 5"}
          </span>
          <span className="text-[12px] text-white/55">
            {data.strikes.length} strikes · 100-step
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2 md:grid-cols-4 xl:grid-cols-6">
          {data.strikes.map((s) => (
            <CompactStrikeCard key={s.strike} s={s} />
          ))}
        </div>
      </div>

      {/* ─── 6. FOOTER STRIP ───────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-2 border-t border-white/[0.08] pt-2">
        <FooterCell label="Trend" value={trend} valueColor={trendColor} />
        <FooterCell
          label="Market Breadth"
          value={data.breadth?.advancing != null && data.breadth?.declining != null
            ? <>
                <span className="text-emerald-400">{data.breadth.advancing} </span>
                <span className="text-[11px] text-white/55">ADV</span>
                <span className="mx-1 text-white/35">·</span>
                <span className="text-rose-400">{data.breadth.declining} </span>
                <span className="text-[11px] text-white/55">DEC</span>
              </>
            : "—"
          }
        />
        <FooterCell
          label="Session"
          value={data.isToday ? "ACTIVE" : "HISTORICAL"}
          valueColor={data.isToday ? "#22c55e" : "#facc15"}
        />
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-white/[0.08] pt-2 text-[10px] text-white/55">
        <span>
          ✓ <span className="font-bold uppercase tracking-wider">LOGIC:</span>{" "}
          AVWAP + FRVP + OI BUILDUP + OI CHANGE + GEX + MTF
        </span>
        <div className="flex items-center gap-3">
          <span><span className="font-bold uppercase tracking-wider">Frame:</span> 5 MIN</span>
          <span><span className="font-bold uppercase tracking-wider">Time:</span> {time}</span>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * LogicRow — one of the 4 main logic rows.
 * ───────────────────────────────────────────────────────────────────── */
function LogicRow({
  n, icon, iconBg, iconColor, title, subtitle, bigText, bigColor, desc, ok,
}: {
  n: number;
  icon: string;
  iconBg: string;
  iconColor: string;
  title: string;
  subtitle: string;
  bigText: string;
  bigColor: string;
  desc: string;
  ok: boolean;
}) {
  return (
    <div className="grid grid-cols-[1fr_1.4fr_1.5fr_auto] items-center gap-3 rounded-sm border border-white/[0.06] bg-white/[0.02] px-3 py-2">
      <div className="flex items-center gap-2.5">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[14px] font-bold"
          style={{ background: iconBg, color: iconColor }}
        >
          {icon}
        </div>
        <div className="flex flex-col">
          <span className="text-[12px] font-bold tracking-wider text-white/95">
            {n}. {title}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-white/55">
            ({subtitle})
          </span>
        </div>
      </div>
      <span
        className="text-[18px] font-black uppercase tracking-tight"
        style={{ color: bigColor }}
      >
        {bigText}
      </span>
      <span className="whitespace-pre-line text-[10px] leading-tight text-white/65">
        {desc}
      </span>
      <span
        className="h-3 w-3 rounded-full"
        style={{ background: ok ? "#22c55e" : "#ef4444", boxShadow: `0 0 8px ${ok ? "#22c55e" : "#ef4444"}88` }}
      />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * DualDonut — 2-slice donut showing CE % (green) vs PE % (red).
 * Center: MARKET STRENGTH + dominant label.
 * ───────────────────────────────────────────────────────────────────── */
function DualDonut({
  bullPct, bearPct, verdict,
}: {
  bullPct: number;
  bearPct: number;
  verdict: V4Decision["overall"];
}) {
  const r = 36;
  const c = 2 * Math.PI * r;
  const bullArc = (bullPct / 100) * c;
  const bearArc = (bearPct / 100) * c;
  const dominant = bullPct >= bearPct ? "BUYERS" : "SELLERS";
  const dominantColor = dominant === "BUYERS" ? "#22c55e" : "#ef4444";
  const label =
    Math.abs(bullPct - 50) >= 35 ? "DOMINANT"
    : Math.abs(bullPct - 50) >= 20 ? "STRONG"
    : Math.abs(bullPct - 50) >= 8  ? "MODERATE"
    : "BALANCED";

  return (
    <div className="relative h-[180px] w-[180px] shrink-0">
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
        <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="10" />
        <circle
          cx="50" cy="50" r={r} fill="none"
          stroke="#22c55e" strokeWidth="10"
          strokeDasharray={`${bullArc} ${c}`}
        />
        <circle
          cx="50" cy="50" r={r} fill="none"
          stroke="#ef4444" strokeWidth="10"
          strokeDasharray={`${bearArc} ${c}`}
          strokeDashoffset={-bullArc}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="text-[10px] font-bold uppercase leading-tight tracking-[0.16em] text-white/65">
          Market<br/>Strength
        </span>
        <span
          className="mt-0.5 text-[14px] font-black leading-none tracking-tight"
          style={{ color: dominantColor }}
        >
          {dominant}
        </span>
        <span className="text-[10px] font-bold uppercase leading-tight tracking-wider" style={{ color: dominantColor, opacity: 0.85 }}>
          {label}
        </span>
        <span className="mt-1 text-[9px] uppercase tracking-wider text-white/45">
          {verdict.grade} · {verdict.confidence}%
        </span>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * CompactStrikeCard — compressed strike card for the 6-col grid.
 * ───────────────────────────────────────────────────────────────────── */
function CompactStrikeCard({ s }: { s: V4Strike }) {
  const isWall = !!s.wall;
  const isTopWall = isWall && s.wall!.tierIdx === 0;
  const wallType = s.wall?.type;

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
    : isWall && wallType === "RESISTANCE" ? "rgba(239,68,68,0.06)"
    : isWall && wallType === "SUPPORT" ? "rgba(34,197,94,0.06)"
    : "rgba(255,255,255,0.02)";

  const dominantColor = s.dominantSide === "CE" ? "#22c55e" : s.dominantSide === "PE" ? "#ef4444" : "rgba(255,255,255,0.55)";

  const wallBadge = isWall ? (wallType === "RESISTANCE" ? "RES" : "SUP") : null;
  const wallBadgeColor = wallType === "RESISTANCE" ? "#ef4444" : "#22c55e";

  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border-2 px-3 py-2.5"
      style={{
        borderColor: `${accent}66`,
        background: bg,
        boxShadow: isTopWall ? `0 0 12px ${accent}55` : "none",
      }}
    >
      <div className="flex items-center justify-between">
        <span
          className="font-mono text-[20px] font-black tabular-nums leading-none"
          style={{ color: s.isAtm ? "#38bdf8" : "rgba(255,255,255,0.95)" }}
        >
          {s.strike}
        </span>
        {s.isAtm ? (
          <span className="rounded-sm bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-sky-300">
            ATM
          </span>
        ) : wallBadge ? (
          <span
            className="rounded-sm px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider"
            style={{ background: `${wallBadgeColor}20`, color: wallBadgeColor }}
          >
            {wallBadge}
          </span>
        ) : (
          <span className="text-[11px] text-white/45">{s.offset > 0 ? `+${s.offset}` : s.offset}</span>
        )}
      </div>
      {/* Dual bar — CE green / PE red side-by-side */}
      <div className="flex h-2.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="h-full"
          style={{
            width: `${s.ce.buyersPct}%`,
            background: "rgba(34,197,94,0.85)",
          }}
        />
        <div
          className="h-full"
          style={{
            width: `${100 - s.ce.buyersPct}%`,
            background: "rgba(239,68,68,0.85)",
          }}
        />
      </div>
      <div className="flex items-center justify-between text-[12px]">
        <span className="font-mono font-bold text-emerald-400">CE {s.ce.buyersPct}%</span>
        <span className="font-mono font-bold text-rose-400">PE {s.pe.buyersPct}%</span>
      </div>
      <div className="flex items-center justify-between border-t border-white/[0.06] pt-1.5">
        <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: dominantColor }}>
          DOM {s.dominantSide}
        </span>
        <span
          className="text-[11px] font-bold uppercase tracking-wider"
          style={{
            color:
              s.marketImpact === "BULLISH" ? "#22c55e"
              : s.marketImpact === "BEARISH" ? "#ef4444"
              : "#facc15",
          }}
        >
          {s.marketImpact === "BULLISH" ? "↑ BULL" : s.marketImpact === "BEARISH" ? "↓ BEAR" : "→ NEU"}
        </span>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * FooterCell — minimal label/value cell for the footer strip.
 * ───────────────────────────────────────────────────────────────────── */
function FooterCell({
  label, value, valueColor,
}: {
  label: string;
  value: React.ReactNode;
  valueColor?: string;
}) {
  return (
    <div className="flex flex-col items-center">
      <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/45">
        {label}
      </span>
      <span
        className="text-[15px] font-black uppercase leading-none tracking-tight"
        style={{ color: valueColor || "rgba(255,255,255,0.95)" }}
      >
        {value}
      </span>
    </div>
  );
}

/* ─── helpers ─────────────────────────────────────────────────────── */
function todayIST(): string {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
}

function formatCompact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e7) return `${(n / 1e7).toFixed(1)} Cr`;
  if (a >= 1e5) return `${(n / 1e5).toFixed(1)} L`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)} K`;
  return `${Math.round(n)}`;
}

// FRVP / POC helpers — derive the "above POC / rising / falling" labels
// from V4 fields. POC isn't directly exposed in V4 yet; we infer using
// the structure migration + VWAP signal as a clean stand-in.
function getPocLabel(d: V4Decision): string {
  const mig = d.engines?.strikeMigration?.bias;
  if (mig === "BULLISH") return "ABOVE POC";
  if (mig === "BEARISH") return "BELOW POC";
  return d.spotPrice > d.vwap ? "ABOVE POC" : "BELOW POC";
}
function getPocColor(d: V4Decision): string {
  const lbl = getPocLabel(d);
  return lbl === "ABOVE POC" ? "#22c55e" : "#ef4444";
}
function getPocOk(d: V4Decision): boolean {
  return getPocLabel(d) === "ABOVE POC";
}
function getPocDesc(d: V4Decision): string {
  const mig = d.engines?.strikeMigration;
  if (mig?.bias === "BULLISH") return `Price above POC\nValue shifting higher`;
  if (mig?.bias === "BEARISH") return `Price below POC\nValue shifting lower`;
  return `Price ${d.spotPrice > d.vwap ? "above" : "below"} POC\nValue area stable`;
}

function oiTrendDesc(d: V4Decision): string {
  const t = d.oiTrend;
  if (!t) return "OI activity quiet";
  const arrow = t.priceDirection === "UP" ? "↑" : "↓";
  if (t.bias === "BULLISH") {
    return t.narrative.includes("BUYERS")
      ? `Price ${arrow}  OI ↑\nLongs being added`
      : `Price ${arrow}  PE writers\nFloors building`;
  }
  if (t.bias === "BEARISH") {
    return t.narrative.includes("WRITERS")
      ? `Price ${arrow}  CE writers\nResistance forming`
      : `Price ${arrow}  PE buyers\nDownside hedges`;
  }
  return `Price ${arrow}  OI mixed\nNo clear positioning`;
}
