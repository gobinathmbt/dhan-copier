import type { IntelV2Snapshot } from "@/lib/intelV2Types";
import { V2_TONE } from "./common";

/**
 * AI EXECUTION ENGINE — the single decision brain.
 * ========================================================================
 * Synthesises HeroZero + TradeStrategy + BestTradePick + MasterVerdict +
 * MarketRegime + TimeOfDay + LateEntry filter + No-Trade score into ONE
 * clear card.
 *
 *   ACTION:    BUY CE | BUY PE | WAIT
 *   MODE:      HERO   | NORMAL | AVOID
 *   ENTRY:     Breakout / Buy Dip / Sell Rise / Reversal / Continuation
 *   CONF:      0..100
 *   WHY:       top 4 supportive reasons
 *   WHY NOT:   blockers / penalties (only on WAIT or stretched moves)
 */
export function ExecutionEngineCard({ data }: { data: IntelV2Snapshot | null }) {
  const ee = data?.dashboard?.executionEngine;
  if (!ee) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-white/[0.08] bg-[#0a0d12] px-4 py-3 text-[12px] text-white/40">
        AI Execution Engine warming up…
      </div>
    );
  }

  const t = V2_TONE[ee.tone];
  const isWait = ee.action === "WAIT";
  const isHero = ee.mode === "HERO";

  // Color system
  const accent = ee.tone === "bull" ? "#22c55e"
    : ee.tone === "bear" ? "#ef4444" : "#facc15";
  const accentSoft = `${accent}10`;
  const accentBorder = `${accent}55`;
  const glow = isHero ? `0 0 40px -8px ${accent}66, inset 0 0 24px ${accent}1a` : "none";

  const modeColor = ee.mode === "HERO" ? "#22c55e"
    : ee.mode === "AVOID" ? "#ef4444" : "#facc15";

  return (
    <div
      className="relative flex h-full min-h-0 flex-col gap-2 overflow-hidden rounded-lg border px-4 py-2.5"
      style={{
        borderColor: accentBorder,
        background: `linear-gradient(135deg, ${accentSoft} 0%, transparent 60%)`,
        boxShadow: glow,
      }}
    >
      {/* Pulse ring on HERO */}
      {isHero ? (
        <span
          className="pointer-events-none absolute inset-0 animate-pulse rounded-lg"
          style={{ boxShadow: `inset 0 0 0 1px ${accent}55` }}
        />
      ) : null}

      {/* TITLE STRIP */}
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.20em]" style={{ color: accent }}>
          <span className="text-[16px]">🧠</span>
          AI EXECUTION ENGINE
          <span className="text-[9px] font-normal text-white/45">(Final Decision)</span>
        </span>
        <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wider">
          <span className="rounded-sm border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-white/65">
            {ee.regimeLabel}
          </span>
          <span className="rounded-sm border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-white/65">
            {ee.phaseLabel}
          </span>
          <span
            className="rounded-sm px-1.5 py-0.5 font-bold"
            style={{ background: `${modeColor}22`, color: modeColor }}
          >
            {ee.mode}
          </span>
        </div>
      </div>

      {/* MAIN ROW — verdict block (BUY CE + bigger confidence ring beside it on the LEFT)
          + entry type / votes on the RIGHT. */}
      <div className="grid grid-cols-[auto_1fr] items-center gap-4">
        {/* LEFT cluster — Action label paired with a large confidence ring */}
        <div className="flex items-center gap-4">
          {/* Action block */}
          <div className="flex flex-col">
            <span
              className="text-[40px] font-black leading-none tracking-[0.04em]"
              style={{ color: accent, textShadow: isHero ? `0 0 14px ${accent}` : "none" }}
            >
              {ee.action}
            </span>
            {ee.targetStrike != null ? (
              <span className="mt-1 font-mono text-[18px] font-bold" style={{ color: accent }}>
                {ee.targetStrike.toLocaleString()} {ee.targetSide}
              </span>
            ) : (
              <span className="mt-1 text-[12px] font-bold uppercase tracking-wider text-white/55">
                {ee.mode === "AVOID" ? "Avoid Entry" : "Standby"}
              </span>
            )}
            <span className="text-[10px] uppercase tracking-wider text-white/55">
              {ee.lifecyclePhase} PHASE
            </span>
          </div>

          {/* Big slim confidence ring sits next to BUY CE */}
          <div className="flex flex-col items-center justify-center gap-1">
            {/* No-Trade chip — sits ABOVE the ring */}
            <span
              className="rounded-sm px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
              style={{
                background: ee.noTradeScore >= 60 ? "rgba(239,68,68,0.20)"
                  : ee.noTradeScore >= 30 ? "rgba(250,204,21,0.20)"
                  : "rgba(34,197,94,0.20)",
                color: ee.noTradeScore >= 60 ? "#ef4444"
                  : ee.noTradeScore >= 30 ? "#facc15"
                  : "#22c55e",
              }}
            >
              No-Trade {ee.noTradeScore}
            </span>
            <div className="relative h-[170px] w-[170px]">
              <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
                <circle cx="50" cy="50" r="44" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3" />
                <circle
                  cx="50" cy="50" r="44" fill="none"
                  stroke={accent} strokeWidth="3" strokeLinecap="round"
                  strokeDasharray={276}
                  strokeDashoffset={276 - (276 * ee.confidence) / 100}
                  style={{ transition: "stroke-dashoffset 0.6s ease" }}
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="font-mono text-[42px] font-black leading-none" style={{ color: accent }}>
                  {ee.confidence}%
                </span>
                <span className="mt-1 text-[9px] font-bold uppercase tracking-[0.18em] text-white/55">
                  Confidence
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT — Entry type + votes */}
        <div className="flex flex-col gap-2 text-[10px]">
          <div
            className="rounded-md border px-3 py-2.5"
            style={{ borderColor: accentBorder, background: accentSoft }}
          >
            <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/65">Entry Type</span>
            <div className="font-mono text-[24px] font-black leading-tight" style={{ color: accent }}>
              {ee.entryType}
            </div>
          </div>
          {/* Vote breakdown — visual hint of consensus */}
          <div className="grid grid-cols-3 gap-1.5">
            <VoteChip label="CE" value={ee.votes.ce} tone="bull" winning={ee.action === "BUY CE"} />
            <VoteChip label="PE" value={ee.votes.pe} tone="bear" winning={ee.action === "BUY PE"} />
            <VoteChip label="WAIT" value={ee.votes.wait} tone="warn" winning={ee.action === "WAIT"} />
          </div>
        </div>
      </div>

      {/* WHY / WHY NOT row */}
      <div className="grid grid-cols-2 gap-2">
        {/* WHY (supportive reasons) */}
        {ee.reasons.length > 0 ? (
          <div
            className="rounded-md border px-2 py-1"
            style={{ borderColor: accentBorder, background: accentSoft }}
          >
            <span className="text-[8px] font-bold uppercase tracking-[0.16em]" style={{ color: accent }}>
              ✓ Why
            </span>
            <div className="mt-0.5 flex flex-wrap gap-1">
              {ee.reasons.map((r, i) => (
                <span
                  key={i}
                  className="rounded-sm px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
                  style={{ background: `${accent}20`, color: accent, border: `1px solid ${accentBorder}` }}
                >
                  {r}
                </span>
              ))}
            </div>
          </div>
        ) : <div />}

        {/* WHY NOT (blockers) */}
        {ee.blockers.length > 0 ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/[0.06] px-2 py-1">
            <span className="text-[8px] font-bold uppercase tracking-[0.16em] text-amber-300">
              ⚠ Why Not
            </span>
            <div className="mt-0.5 flex flex-wrap gap-1">
              {ee.blockers.map((b, i) => (
                <span
                  key={i}
                  className="rounded-sm border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-200"
                >
                  {b}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.06] px-2 py-1 text-center text-[10px] font-bold uppercase tracking-wider text-emerald-300">
            ✓ All filters passed
          </div>
        )}
      </div>
    </div>
  );
}

function VoteChip({ label, value, tone, winning }: {
  label: string;
  value: number;
  tone: "bull" | "bear" | "warn";
  winning: boolean;
}) {
  const t = V2_TONE[tone];
  return (
    <div
      className="flex items-center justify-between rounded-sm border px-2.5 py-1.5"
      style={{
        background: winning ? `${t.color}22` : "rgba(255,255,255,0.02)",
        borderColor: winning ? `${t.color}55` : "rgba(255,255,255,0.06)",
      }}
    >
      <span className="text-[10px] font-bold uppercase tracking-wider text-white/65">{label}</span>
      <span
        className="font-mono text-[14px] font-bold tabular-nums"
        style={{ color: winning ? t.color : "rgba(255,255,255,0.75)" }}
      >
        {value}
      </span>
    </div>
  );
}
