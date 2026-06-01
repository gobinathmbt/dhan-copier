import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { isAuthenticated } from "@/lib/auth";
import { useIntelV5Decision } from "@/hooks/useIntelV5Decision";
import type { V5Symbol, V5Decision } from "@/lib/intelV5Types";

export const Route = createFileRoute("/intel-v5")({
  component: IntelV5Page,
});

/**
 * INTEL V5 — Institutional Option Buyer Verdict
 * ========================================================================
 * Bloomberg-style minimal layout:
 *   • Top:    MARKET CONTROL + ACTION + CONFIDENCE
 *   • Middle: 6 institutional layers (OI · AVWAP · FRVP · POC · FUT · CPR)
 *   • Right:  Flow Score gauge
 *   • Bottom: SUPPORT  ··  LIVE SPOT  ··  RESISTANCE
 *   • Footer: RISK · TRAP · REGIME
 *
 * No charts. No clutter. Pure positioning → control → action.
 */
function IntelV5Page() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!isAuthenticated()) navigate({ to: "/login" });
  }, [navigate]);

  const [symbol, setSymbol] = useState<V5Symbol>("NIFTY_50");
  const [date, setDate] = useState<string | null>(null);
  const { data, loading, lastFetchAt, refetch } = useIntelV5Decision({ symbol, date, intervalMs: 3000 });

  return (
    <div className="intelv5-root fixed inset-0 left-16 flex flex-col bg-[#070a0e] font-mono text-white">
      <header className="flex items-center justify-between border-b border-white/[0.08] bg-[#0a0d12] px-5 py-2">
        <div className="flex items-center gap-3">
          <span className="text-[14px] font-bold tracking-[0.20em] text-emerald-400">
            INTEL <span className="rounded-sm bg-emerald-400/15 px-2 py-0.5 text-[12px]">V5</span>
          </span>
          <span className="text-[11px] uppercase tracking-[0.18em] text-white/55">
            Institutional Option Buyer Verdict
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

      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
        {!data ? (
          <div className="flex h-full items-center justify-center text-[14px] text-white/45">Loading V5…</div>
        ) : !data.ok ? (
          <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-6 text-rose-300">
            <div className="text-[13px] font-bold uppercase tracking-wider">Engine Error</div>
            <div className="mt-2 text-[12px]">{(data as unknown as { error?: string }).error || "Unable to load."}</div>
          </div>
        ) : (
          <V5Card data={data} />
        )}
      </main>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * V5Card — the entire dashboard inside one bordered Bloomberg card.
 * ───────────────────────────────────────────────────────────────────── */
function V5Card({ data }: { data: V5Decision }) {
  const verdictTone =
    data.verdict === "BUY CE" ? "#22c55e"
    : data.verdict === "BUY PE" ? "#ef4444"
    : "#facc15";
  const controlTone =
    data.control === "BUYERS" ? "#22c55e"
    : data.control === "SELLERS" ? "#ef4444"
    : "#facc15";

  return (
    <div
      className="flex w-full flex-1 flex-col gap-3 rounded-2xl border-2 px-5 py-4 shadow-[0_0_30px_rgba(0,0,0,0.5)]"
      style={{ borderColor: `${verdictTone}88` }}
    >
      {/* ─── TOP ROW — CONTROL · ACTION · CONFIDENCE · FLOW SCORE ────── */}
      <div className="grid grid-cols-4 gap-3 border-b border-white/[0.08] pb-3">
        <Tile label="Market Control" value={data.control} valueColor={controlTone} />
        <Tile label="Action" value={data.verdict} valueColor={verdictTone} big />
        <Tile
          label="Confidence"
          value={
            <div className="flex flex-col items-center">
              <span style={{ color: verdictTone }}>{data.confidence}%</span>
              <span className="text-[11px] font-bold tracking-wider" style={{ color: verdictTone, opacity: 0.85 }}>
                {data.conviction} · {data.grade}
              </span>
            </div>
          }
          valueColor={verdictTone}
        />
        <FlowScoreTile score={data.flowScore} verdictTone={verdictTone} />
      </div>

      {/* ─── MIDDLE — 6 LAYERS as info-dense rows ──────────────────────── */}
      <div className="grid grid-cols-2 gap-2">
        <LayerRow
          tag="OI"
          title="OI BUILDUP"
          subtitle="Position Building"
          value={data.layers.oiBuildup.label.toUpperCase()}
          bias={data.layers.oiBuildup.bias}
          desc={data.layers.oiBuildup.narrative}
        />
        <LayerRow
          tag="ΔOI"
          title="OI CHANGE"
          subtitle="Fresh Money"
          value={data.layers.oiChange.label}
          bias={data.layers.oiChange.bias}
          desc={`CE ${data.layers.oiChange.cePct >= 0 ? "+" : ""}${data.layers.oiChange.cePct}% · PE ${data.layers.oiChange.pePct >= 0 ? "+" : ""}${data.layers.oiChange.pePct}%`}
        />
        <LayerRow
          tag="VWAP"
          title="AVWAP"
          subtitle="Auction Control"
          value={data.layers.avwap.label}
          bias={data.layers.avwap.bias}
          desc={`Spot ${data.layers.avwap.distance >= 0 ? "+" : ""}${data.layers.avwap.distance.toFixed(2)} from AVWAP`}
        />
        <LayerRow
          tag="POC"
          title="FRVP"
          subtitle="Value Acceptance"
          value={`${data.layers.frvp.label} · ${data.layers.frvp.pocMigration}`}
          bias={data.layers.frvp.bias}
          desc={data.layers.frvp.narrative}
        />
        <LayerRow
          tag="FUT"
          title="FUTURES"
          subtitle="Institutional Basis"
          value={`${data.layers.futures.label} ${data.layers.futures.premium >= 0 ? "+" : ""}${data.layers.futures.premium}`}
          bias={data.layers.futures.bias}
          desc={data.layers.futures.narrative}
        />
        <LayerRow
          tag="CPR"
          title="CPR"
          subtitle="Day Context"
          value={data.layers.cpr.label}
          bias={data.layers.cpr.bias}
          desc={data.layers.cpr.narrative}
        />
      </div>

      {/* ─── BOTTOM — RESISTANCE · LIVE SPOT · SUPPORT (swapped) ────── */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-4 border-y border-white/[0.08] py-4">
        <WallList side="RESISTANCE" tone="#ef4444" walls={data.levels.resistance} />
        <SpotPanel data={data} />
        <WallList side="SUPPORT" tone="#22c55e" walls={data.levels.support} />
      </div>

      {/* ─── FOOTER ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-3">
        <FooterCell
          label="Risk"
          value={data.risk.level}
          color={data.risk.level === "LOW" ? "#22c55e" : data.risk.level === "MEDIUM" ? "#facc15" : "#ef4444"}
        />
        <FooterCell
          label="Trap"
          value={data.trap.label}
          color={data.trap.count > 0 ? "#ef4444" : "#22c55e"}
        />
        <FooterCell
          label="Regime"
          value={data.regime.label}
          color={data.regime.label === "TRENDING" ? "#22c55e" : data.regime.label === "CHOP" ? "#ef4444" : "#facc15"}
        />
      </div>

      {/* WAIT GATES (only when present) */}
      {data.waitGates.length > 0 ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/[0.06] px-3 py-2">
          <span className="mr-2 text-[11px] font-bold uppercase tracking-[0.18em] text-amber-300">
            ⚠ Wait Gates
          </span>
          <span className="text-[11px] text-white/75">
            {data.waitGates.join(" · ")}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * Tile — top-row hero metric.
 * ───────────────────────────────────────────────────────────────────── */
function Tile({
  label, value, valueColor, big,
}: {
  label: string;
  value: React.ReactNode;
  valueColor?: string;
  big?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-3">
      <span className="text-[11px] font-bold uppercase tracking-[0.20em] text-white/55">
        {label}
      </span>
      <div
        className="font-mono font-black uppercase leading-none tracking-tight"
        style={{
          color: valueColor || "rgba(255,255,255,0.95)",
          fontSize: big ? "44px" : "32px",
          textShadow: valueColor ? `0 0 12px ${valueColor}40` : "none",
        }}
      >
        {value}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * FlowScoreTile — ring + score.
 * ───────────────────────────────────────────────────────────────────── */
function FlowScoreTile({ score, verdictTone }: { score: number; verdictTone: string }) {
  const r = 36;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, score));
  const arc = (v / 100) * c;
  const label =
    v >= 80 ? "EXTREME" :
    v >= 60 ? "STRONG" :
    v >= 40 ? "MODERATE" :
    v >= 20 ? "WEAK" :
    "QUIET";
  const labelColor =
    v >= 60 ? verdictTone :
    v >= 40 ? "#facc15" :
    "rgba(255,255,255,0.55)";
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-3">
      <span className="text-[11px] font-bold uppercase tracking-[0.20em] text-white/55">
        Flow Score
      </span>
      <div className="relative h-[100px] w-[100px]">
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
          <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="8" />
          <circle
            cx="50" cy="50" r={r} fill="none"
            stroke={verdictTone} strokeWidth="8" strokeLinecap="round"
            strokeDasharray={`${arc} ${c}`}
            style={{ transition: "stroke-dasharray 0.5s ease", filter: `drop-shadow(0 0 4px ${verdictTone}66)` }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono text-[26px] font-black tabular-nums leading-none" style={{ color: verdictTone }}>
            {v}
          </span>
          <span className="text-[10px] font-bold uppercase tracking-wider text-white/55">
            / 100
          </span>
        </div>
      </div>
      <span
        className="rounded-sm px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider"
        style={{ background: `${labelColor}22`, color: labelColor }}
      >
        {label}
      </span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * LayerRow — one of the 6 institutional layers.
 * ───────────────────────────────────────────────────────────────────── */
function LayerRow({
  tag, title, subtitle, value, bias, desc,
}: {
  tag: string;
  title: string;
  subtitle: string;
  value: string;
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  desc: string;
}) {
  const c = bias === "BULLISH" ? "#22c55e" : bias === "BEARISH" ? "#ef4444" : "#facc15";
  const biasIcon = bias === "BULLISH" ? "↑" : bias === "BEARISH" ? "↓" : "→";
  const biasShort = bias === "BULLISH" ? "BULL" : bias === "BEARISH" ? "BEAR" : "NEU";
  return (
    <div
      className="grid grid-cols-[60px_1fr_auto] items-center gap-4 rounded-md border-2 px-4 py-3.5"
      style={{ borderColor: `${c}55`, background: `${c}12` }}
    >
      <div
        className="flex h-14 w-14 items-center justify-center rounded-full text-[16px] font-black"
        style={{ background: `${c}28`, color: c, border: `2px solid ${c}70` }}
      >
        {tag}
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline gap-3">
          <span className="text-[16px] font-black uppercase tracking-wider text-white/95">
            {title}
          </span>
          <span className="text-[12px] font-bold uppercase tracking-[0.18em] text-white/55">
            {subtitle}
          </span>
        </div>
        <span className="text-[22px] font-black uppercase tracking-tight" style={{ color: c }}>
          {value}
        </span>
        {/* Interpretation — full sentence, not truncated, larger size so it
            stays readable without hover. Wraps naturally across multiple
            lines if needed. */}
        <span className="text-[14px] font-medium leading-snug text-white/85">
          {desc}
        </span>
      </div>
      {/* Status pill — text + glowing dot. */}
      <div className="flex flex-col items-center gap-2">
        <span
          className="rounded-md px-3 py-1.5 text-[14px] font-black uppercase tracking-wider"
          style={{ background: `${c}28`, color: c, border: `2px solid ${c}88`, boxShadow: `0 0 8px ${c}33` }}
        >
          {biasIcon} {biasShort}
        </span>
        <span
          className="h-3.5 w-3.5 rounded-full"
          style={{ background: c, boxShadow: `0 0 14px ${c}` }}
        />
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * WallList — full institutional wall block per side.
 *  • RESISTANCE shown on the LEFT (text right-aligned toward spot)
 *  • SUPPORT shown on the RIGHT (text left-aligned toward spot)
 *  • Each wall row carries strike + side + tier + OI + ΔOI in big text
 * ───────────────────────────────────────────────────────────────────── */
function WallList({
  side, tone, walls,
}: {
  side: "SUPPORT" | "RESISTANCE";
  tone: string;
  walls: V5Decision["levels"]["support"];
}) {
  const isLeft = side === "RESISTANCE";
  const fmtOi = (n: number) => {
    const a = Math.abs(n);
    if (a >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
    if (a >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
    if (a >= 1e3) return `${(n / 1e3).toFixed(0)} K`;
    return `${Math.round(n)}`;
  };
  return (
    <div className={`flex flex-col gap-2 ${isLeft ? "items-end" : "items-start"}`}>
      <span
        className="rounded-md border-2 px-3 py-1 text-[14px] font-black uppercase tracking-[0.20em]"
        style={{ borderColor: `${tone}80`, background: `${tone}1a`, color: tone, boxShadow: `0 0 12px ${tone}33` }}
      >
        {side}
      </span>
      <div className="flex w-full flex-col gap-2">
        {walls.length === 0 ? (
          <div
            className="rounded-md border px-4 py-3 text-[13px] text-white/45"
            style={{ borderColor: `${tone}30`, background: `${tone}08` }}
          >
            No wall in window
          </div>
        ) : (
          walls.map((w, i) => (
            <div
              key={w.strike}
              className={`flex items-center justify-between rounded-md border-2 px-4 py-3 ${isLeft ? "flex-row-reverse text-right" : "text-left"}`}
              style={{
                borderColor: `${tone}55`,
                background: `${tone}12`,
                boxShadow: i === 0 ? `0 0 16px ${tone}40` : "none",
              }}
            >
              <div className={`flex flex-col ${isLeft ? "items-end" : "items-start"}`}>
                <span className="font-mono text-[28px] font-black tabular-nums leading-none" style={{ color: tone }}>
                  {w.strike} <span className="text-[16px] opacity-75">{w.side}</span>
                </span>
                <span className="mt-1 text-[11px] font-bold uppercase tracking-[0.14em] text-white/65">
                  {w.tier}
                </span>
              </div>
              <div className={`flex flex-col ${isLeft ? "items-start" : "items-end"} text-[12px]`}>
                <span className="text-[10px] font-bold uppercase tracking-wider text-white/45">OI</span>
                <span className="font-mono text-[15px] font-bold tabular-nums text-white/85">
                  {fmtOi(w.oi)}
                </span>
                <span
                  className="mt-0.5 font-mono text-[11px] tabular-nums"
                  style={{ color: w.oiChange >= 0 ? "#22c55e" : "#ef4444" }}
                >
                  Δ {w.oiChange >= 0 ? "+" : ""}{fmtOi(w.oiChange)}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * SpotPanel — center spot price + ATM marker.
 * ───────────────────────────────────────────────────────────────────── */
function SpotPanel({ data }: { data: V5Decision }) {
  return (
    <div className="flex min-w-[260px] flex-col items-center justify-center gap-1 rounded-md border-2 border-sky-500/50 bg-sky-500/[0.10] px-5 py-4 shadow-[0_0_18px_rgba(56,189,248,0.20)]">
      <span className="text-[12px] font-bold uppercase tracking-[0.22em] text-sky-300">
        Live Spot
      </span>
      <span className="font-mono text-[44px] font-black tabular-nums leading-none text-sky-300">
        {data.spotPrice.toLocaleString()}
      </span>
      <div className="mt-2 flex items-center gap-3 text-[12px] uppercase tracking-wider text-white/65">
        <span>ATM <span className="font-mono font-bold text-white/95">{data.atm ?? "—"}</span></span>
        <span className="text-white/25">·</span>
        <span>VWAP <span className="font-mono font-bold text-white/95">{data.vwap.toFixed(2)}</span></span>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * FooterCell — risk / trap / regime cell.
 * ───────────────────────────────────────────────────────────────────── */
function FooterCell({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex items-center justify-between rounded-md border border-white/[0.08] bg-white/[0.02] px-4 py-2">
      <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/55">
        {label}
      </span>
      <span className="text-[16px] font-black uppercase tracking-tight" style={{ color }}>
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
