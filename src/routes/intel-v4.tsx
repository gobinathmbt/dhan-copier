import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { isAuthenticated } from "@/lib/auth";
import { useIntelV4Decision } from "@/hooks/useIntelV4Decision";
import type { V4Symbol, V4Strike } from "@/lib/intelV4Types";

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

            {/* ─── REASONS ───────────────────────────────────────────── */}
            {o?.reasons && o.reasons.length > 0 ? (
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
            ) : null}

            {/* ─── PER-STRIKE CARDS (ATM ± 5) ────────────────────────
                Each strike rendered as its own info-dense card.
                ATM card highlighted in sky-blue.
                Card layout responsive: 4 cols ≥ xl, 3 cols lg, 2 cols md. */}
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/65">
                  Strike Domination — ATM ± 5
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
 * ATM card gets a brighter sky-blue accent.
 * ───────────────────────────────────────────────────────────────────── */
function StrikeCard({ s }: { s: V4Strike }) {
  // Border + background based on impact / ATM
  const accent =
    s.isAtm ? "#38bdf8"
    : s.marketImpact === "BULLISH" ? "#22c55e"
    : s.marketImpact === "BEARISH" ? "#ef4444"
    : "rgba(255,255,255,0.18)";
  const bg =
    s.isAtm ? "rgba(56,189,248,0.08)"
    : s.marketImpact === "BULLISH" ? "rgba(34,197,94,0.05)"
    : s.marketImpact === "BEARISH" ? "rgba(239,68,68,0.05)"
    : "rgba(255,255,255,0.02)";
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

  return (
    <div
      className="flex flex-col gap-2 rounded-md border px-3 py-2.5 transition-shadow hover:shadow-[0_0_12px_rgba(56,189,248,0.15)]"
      style={{
        borderColor: `${accent}55`,
        background: bg,
        boxShadow: s.isAtm ? `inset 0 0 0 1px ${accent}40` : "none",
      }}
    >
      {/* HEADER — strike + ATM badge + impact pill */}
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
 * Renders Buy% / Sell% bar + buildup tag.
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
      <span className="truncate text-[10px] text-white/65" title={side.buildup}>
        {side.buildup === "—" ? "no data" : side.buildup}
      </span>
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
