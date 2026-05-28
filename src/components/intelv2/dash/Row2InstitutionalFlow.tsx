import type { IntelV2Snapshot } from "@/lib/intelV2Types";
import { V2Card, V2Pill, v2Fmt, V2_TONE, V2Hint } from "./common";
// 2.3 OI Buildup Analysis — REMOVED. Functionality covered by 2.2 Combined card.
// import { OiBuildupAnalysisCard } from "./OiBuildupAnalysisCard";
import { SupportResistanceCardV2 } from "./SupportResistanceCard";
// MarketDirectionCard is now embedded inside CombinedWritingMarketCard,
// no longer rendered standalone. The file remains for reference.
// import { MarketDirectionCard } from "./MarketDirectionCard";

export function Row2InstitutionalFlow({ data }: { data: IntelV2Snapshot | null }) {
  return (
    <div className="flex flex-col gap-2">
      {/* 2.2 Market Direction (60%) + 2.5 FRVP Institutional Map (40%) â€”
          height reduced since the Writing Pressure top tables were merged
          into the Intraday Levels block. */}
      <div className="grid h-[600px] grid-cols-10 gap-2">
        <div className="col-span-6 min-h-0">
          <CombinedWritingMarketCard data={data} />
        </div>
        <div className="col-span-4 min-h-0">
          <FrvpInstitutional data={data} />
        </div>
      </div>

      {/* Below row â€” Support/Resistance Pressure full width */}
      <div className="grid h-[420px] grid-cols-1 gap-2">
        <div className="min-h-0">
          <SupportResistanceCardV2 data={data} />
        </div>
      </div>

      {/* 2.3 OI Buildup Analysis â€” REMOVED. Combined into 2.2 Writing+Market */}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * 2.2 — COMBINED CARD
 * Wraps the existing WritingPressure (CE Walls / PE Walls / footer) on
 * top and the MarketDirectionCard (meter + intraday levels + OI move)
 * on the bottom — both stacked inside a single V2Card.
 * ───────────────────────────────────────────────────────────────────── */
function CombinedWritingMarketCard({ data }: { data: IntelV2Snapshot | null }) {
  return (
    <V2Card
      title={
        <span className="flex items-center gap-2">
          2.2 Market Direction
          <span className="text-[9px] font-normal text-white/45">
            (Direction Meter + Intraday Levels + OI Move)
          </span>
        </span>
      }
    >
      <div className="-m-1.5 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-1.5 pr-2">
        {/* Writing Pressure top tables removed â€” all info merged into the
            Intraday Levels table inside CombinedMarketDirectionBody. */}
        {/* <CombinedWritingPressureBody data={data} /> */}
        <CombinedMarketDirectionBody data={data} />
      </div>
    </V2Card>
  );
}

/* ── Writing Pressure body (no V2Card wrapper — for combined card) ── */
function CombinedWritingPressureBody({ data }: { data: IntelV2Snapshot | null }) {
  const ana = data?.dashboard?.oiBuildupAnalysis;
  const atm = data?.options?.atm;
  if (!ana || !atm) {
    return (
      <div className="flex items-center justify-center py-4 text-[12px] text-white/40">
        No OI buildup data
      </div>
    );
  }
  // Restrict candidate strikes to 100-spaced strikes within ATM ± 6.
  // Ensures the resistance / support ladders show clean strikes only —
  // never 23950, only 23900 / 24000 / 24100 etc.
  const anchor = Math.round(atm / 100) * 100;
  const lo = anchor - 6 * 100;
  const hi = anchor + 6 * 100;
  const isClean = (k: number) => k % 100 === 0 && k >= lo && k <= hi;

  const ceStrikes = [...ana.ceTable]
    .filter(r => isClean(r.strike) && r.strike >= anchor)
    .sort((a, b) => Math.abs(b.oiChange) - Math.abs(a.oiChange))
    .slice(0, 6)
    .sort((a, b) => b.strike - a.strike);
  const peStrikes = [...ana.peTable]
    .filter(r => isClean(r.strike) && r.strike <= anchor)
    .sort((a, b) => Math.abs(b.oiChange) - Math.abs(a.oiChange))
    .slice(0, 6)
    .sort((a, b) => b.strike - a.strike);
  const ceTotalPct = ceStrikes.reduce((s, r) => s + Math.max(0, r.oiChangePct), 0);
  const peTotalPct = peStrikes.reduce((s, r) => s + Math.max(0, r.oiChangePct), 0);
  const ceActivity = ceTotalPct >= 250 ? "Aggressive"
    : ceTotalPct >= 120 ? "Active"
      : ceTotalPct >= 50 ? "Moderate" : "Light";
  const peActivity = peTotalPct >= 250 ? "Aggressive"
    : peTotalPct >= 120 ? "Active"
      : peTotalPct >= 50 ? "Moderate" : "Light";
  const ceLo = ceStrikes.length ? Math.min(...ceStrikes.map(r => r.strike)) : null;
  const ceHi = ceStrikes.length ? Math.max(...ceStrikes.map(r => r.strike)) : null;
  const peLo = peStrikes.length ? Math.min(...peStrikes.map(r => r.strike)) : null;
  const peHi = peStrikes.length ? Math.max(...peStrikes.map(r => r.strike)) : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-sky-300">
        Writing Pressure (Resistance & Support)
      </div>
      <div className="grid min-h-0 grid-cols-2 gap-2">
        <WritingPanel side="CE" rows={ceStrikes} activity={ceActivity} rangeLo={ceLo} rangeHi={ceHi} />
        <WritingPanel side="PE" rows={peStrikes} activity={peActivity} rangeLo={peLo} rangeHi={peHi} />
      </div>
    </div>
  );
}

/* ── Market Direction body (no V2Card wrapper — for combined card) ── */
function CombinedMarketDirectionBody({ data }: { data: IntelV2Snapshot | null }) {
  // Re-use the standalone MarketDirectionCard logic by inlining its body.
  // We strip the outer V2Card so it nests cleanly inside the combined card.
  const md = data?.dashboard?.marketDirection;
  if (!md) {
    return (
      <div className="flex items-center justify-center py-4 text-[12px] text-white/40">
        Awaiting market direction data…
      </div>
    );
  }
  const m = md.directionMeter;
  const move = md.oiEstimatedMove;
  const verdictColor = V2_TONE[m.tone].color;
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-sky-300">
        Market Direction
      </div>

      {/* 1. Direction Meter */}
      <div className="flex flex-col gap-1.5">
        <div className="relative h-3 w-full overflow-visible rounded-full">
          <div
            className="absolute inset-0 rounded-full"
            style={{
              background:
                "linear-gradient(to right, rgba(239,68,68,0.85) 0%, rgba(239,68,68,0.55) 30%, rgba(250,204,21,0.55) 50%, rgba(34,197,94,0.55) 70%, rgba(34,197,94,0.85) 100%)",
            }}
          />
          <div className="absolute -top-1 -translate-x-1/2" style={{ left: `${m.needlePos}%` }}>
            <div className="h-5 w-2.5 rounded-sm border-2 border-white bg-white shadow-[0_0_6px_rgba(255,255,255,0.6)]" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-md border border-rose-500/40 bg-rose-500/[0.10] px-3 py-1.5">
            <div className="font-mono text-[20px] font-black leading-none text-rose-400">{m.downside}%</div>
            <div className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.16em] text-rose-400">Downside</div>
          </div>
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/[0.10] px-3 py-1.5 text-right">
            <div className="font-mono text-[20px] font-black leading-none text-emerald-400">{m.upside}%</div>
            <div className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-400">Upside</div>
          </div>
        </div>
        <div className="flex items-center justify-center">
          <span
            className="rounded-sm px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.16em]"
            style={{ background: verdictColor + "22", color: verdictColor }}
          >
            {m.verdict}
          </span>
        </div>
      </div>

      {/* 2. Intraday Levels (Important) â€” Excel-style mirrored ladder.
          Single continuous ladder sorted by strike DESC. Resistances render
          with label LEFT + strike CENTER; supports flip to strike CENTER +
          label RIGHT. ATM is intentionally excluded â€” it's neither a
          resistance nor a support. */}
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/85">
          Intraday Levels <span className="text-white/45">(CE Walls left Â· ATM center Â· PE Walls right)</span>
        </span>
        <div className="overflow-hidden rounded-md border border-white/[0.08]">
          {/* Mirror header — same 6 columns rendered on both halves */}
          <div className="grid grid-cols-2 items-center gap-2 border-b border-white/[0.08] bg-white/[0.03] px-2 py-1">
            <LevelHeader />
            <LevelHeader />
          </div>
          {(() => {
            type Row = {
              strike: number;
              tier: string;
              side: "resistance" | "support" | "atm";
              oi: number;
              oiChange: number;
              oiChangePct: number;
              interpretation: string;
            };
            const atmStrike = data?.options?.atm ?? null;
            const anchor = atmStrike != null ? Math.round(atmStrike / 100) * 100 : null;
            const ana = data?.dashboard?.oiBuildupAnalysis;

            // Index ceTable / peTable by strike for O(1) lookup of OI/buildup data
            const ceByStrike = new Map<number, { oi: number; oiChange: number; oiChangePct: number; interpretation: string }>();
            const peByStrike = new Map<number, { oi: number; oiChange: number; oiChangePct: number; interpretation: string }>();
            for (const r of ana?.ceTable || []) {
              ceByStrike.set(r.strike, {
                oi: r.oiToday, oiChange: r.oiChange,
                oiChangePct: r.oiChangePct, interpretation: r.interpretation,
              });
            }
            for (const r of ana?.peTable || []) {
              peByStrike.set(r.strike, {
                oi: r.oiToday, oiChange: r.oiChange,
                oiChangePct: r.oiChangePct, interpretation: r.interpretation,
              });
            }

            const byStrike = new Map<number, Row>();
            const lookup = (strike: number, side: "resistance" | "support" | "atm") => {
              // Resistance / ATM-from-CE side → use ce data; Support → use pe data.
              const src = side === "support" ? peByStrike.get(strike) : ceByStrike.get(strike);
              return {
                oi: src?.oi ?? 0,
                oiChange: src?.oiChange ?? 0,
                oiChangePct: src?.oiChangePct ?? 0,
                interpretation: src?.interpretation ?? "â€”",
              };
            };

            for (const r of md.resistances) {
              if (anchor != null && r.strike === anchor) continue;
              byStrike.set(r.strike, { strike: r.strike, tier: r.tier, side: "resistance", ...lookup(r.strike, "resistance") });
            }
            for (const r of md.supports) {
              if (anchor != null && r.strike === anchor) continue;
              if (byStrike.has(r.strike)) continue;
              byStrike.set(r.strike, { strike: r.strike, tier: r.tier, side: "support", ...lookup(r.strike, "support") });
            }
            if (anchor != null) {
              byStrike.set(anchor, { strike: anchor, tier: "ATM", side: "atm", ...lookup(anchor, "atm") });
            }

            const rows = [...byStrike.values()].sort((a, b) => b.strike - a.strike);
            if (rows.length === 0) {
              return <div className="px-2 py-2 text-center text-[10px] text-white/45">No level data</div>;
            }
            return rows.map((r, i) => (
              <ExcelLevelRow
                key={r.strike}
                tier={r.tier}
                strike={r.strike}
                side={r.side}
                first={i === 0}
                oi={r.oi}
                oiChange={r.oiChange}
                oiChangePct={r.oiChangePct}
                interpretation={r.interpretation}
              />
            ));
          })()}
        </div>
      </div>

      {/* 3. OI Estimated Move */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-sky-300">OI Estimated Move</span>
        <div className="grid grid-cols-3 gap-2">
          <CombinedTargetTile label="Upside Target" value={move.upsideTarget} tone="bull" icon="▲" />
          <CombinedTargetTile label="Downside Target" value={move.downsideTarget} tone="bear" icon="▼" />
          <div className="flex flex-col items-center justify-center rounded-md border border-amber-500/40 bg-amber-500/[0.06] py-1">
            <span className="text-[9px] font-bold uppercase tracking-[0.16em] text-amber-300">Max Pain</span>
            <span className="font-mono text-[18px] font-black tabular-nums text-amber-300">
              {move.maxPain ? move.maxPain.toLocaleString() : "—"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function CombinedLevelRow({
  label, value, tone, first,
}: {
  label: string;
  value: number;
  tone: "bull" | "bear";
  first: boolean;
}) {
  const t = V2_TONE[tone];
  return (
    <div
      className={`flex items-center justify-between px-3 py-2 text-[13px] ${!first ? "border-t border-white/[0.04]" : ""
        }`}
    >
      <span className="text-white/80">{label}</span>
      <span className="font-mono text-[15px] font-bold tabular-nums" style={{ color: t.color }}>
        {value.toLocaleString()}
      </span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * Mirrored Intraday Levels row.
 *   • Resistance rows  → ALL content on LEFT half (green tones, "CE" tag)
 *   • ATM row          → centered, blue tones, just strike + "ATM" tag
 *   • Support rows     → ALL content on RIGHT half (red tones, "PE" tag)
 *
 * Each side packs: Tier · Strike · OI · Δ% · Strength bar · Interpretation
 * ───────────────────────────────────────────────────────────────────── */

// Header row — matches the 6 inner columns of the metric strip
function LevelHeader() {
  return (
    <div className="grid grid-cols-[1.4fr_72px_44px_46px_60px_1fr] items-center gap-1.5 px-2 text-[8px] font-bold uppercase tracking-wider text-white/45">
      <span>Tier</span>
      <span className="text-right">Strike</span>
      <span className="text-right">OI Build</span>
      <span className="text-right">Change</span>
      <span className="text-center">Strength</span>
      <span className="text-right">Interpretation</span>
    </div>
  );
}

function ExcelLevelRow({
  tier, strike, side, first,
  oi = 0, oiChange = 0, oiChangePct = 0, interpretation = "—",
}: {
  tier: string;
  strike: number;
  side: "resistance" | "support" | "atm";
  first: boolean;
  oi?: number;
  oiChange?: number;
  oiChangePct?: number;
  interpretation?: string;
}) {
  const isRes = side === "resistance";
  const isAtm = side === "atm";

  // Tones
  const accent = isAtm ? "#38bdf8" : isRes ? "#86efac" : "#fda4af";
  const sideBg = isAtm ? "rgba(56,189,248,0.10)"
    : isRes ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)";
  const sideBorder = isAtm ? "rgba(56,189,248,0.30)"
    : isRes ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.25)";

  // Strength bar — 7 segments scaled by |oiChangePct|
  const pctClamped = Math.min(100, Math.max(0, Math.abs(oiChangePct)));
  const filled = Math.round((pctClamped / 100) * 7);
  const pctSign = oiChangePct >= 0 ? "+" : "";

  // Inner content (used for both CE-left and PE-right sides — aligned 6-column metric table)
  const InnerStrip = (
    <div
      className="grid grid-cols-[1.4fr_72px_44px_46px_60px_1fr] items-center gap-1.5 rounded-sm px-2 py-1 text-[10px]"
      style={{ background: sideBg, border: `1px solid ${sideBorder}` }}
    >
      {/* Tier */}
      <span className="truncate text-[9px] font-bold uppercase tracking-wide" style={{ color: accent }}>
        {tier}
      </span>
      {/* Strike + tag */}
      <span className="flex items-baseline justify-end gap-1">
        <span className="font-mono text-[12px] font-bold tabular-nums" style={{ color: accent }}>
          {strike.toLocaleString()}
        </span>
        <span className="text-[8px] font-bold uppercase opacity-75" style={{ color: accent }}>
          {isAtm ? "ATM" : isRes ? "CE" : "PE"}
        </span>
      </span>
      {/* OI in lakhs */}
      <span className="text-right font-mono tabular-nums text-white/80">
        {oi > 0 ? `${(oi / 1e5).toFixed(1)}L` : "—"}
      </span>
      {/* Δ% */}
      <span
        className="text-right font-mono font-bold tabular-nums"
        style={{ color: oiChangePct >= 0 ? accent : "#fda4af" }}
      >
        {oiChangePct === 0 ? "—" : `${pctSign}${oiChangePct.toFixed(1)}%`}
      </span>
      {/* Strength bar */}
      <span className="flex items-center justify-center gap-[2px]">
        {Array.from({ length: 7 }).map((_, idx) => (
          <span
            key={idx}
            className="block h-2 w-1.5 rounded-[1px]"
            style={{
              background: idx < filled ? accent : "rgba(255,255,255,0.10)",
            }}
          />
        ))}
      </span>
      {/* Interpretation */}
      <span className="truncate text-right" style={{ color: accent, opacity: 0.85 }}>
        {interpretation}
      </span>
    </div>
  );

  // ATM row — centered single strip
  if (isAtm) {
    return (
      <div
        className={`grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-2 py-1 ${first ? "" : "border-t border-white/[0.04]"
          }`}
      >
        <div />
        <div
          className="flex items-baseline gap-1.5 rounded-sm border px-3 py-1"
          style={{ background: sideBg, borderColor: sideBorder }}
        >
          <span className="font-mono text-[14px] font-bold tabular-nums" style={{ color: accent }}>
            {strike.toLocaleString()}
          </span>
          <span className="text-[9px] font-bold uppercase tracking-wider opacity-80" style={{ color: accent }}>
            ATM
          </span>
        </div>
        <div />
      </div>
    );
  }

  // Resistance — content on LEFT, empty on RIGHT
  // Support    — empty on LEFT, content on RIGHT
  return (
    <div
      className={`grid grid-cols-2 items-center gap-2 px-2 py-1 ${first ? "" : "border-t border-white/[0.04]"
        }`}
    >
      {isRes ? InnerStrip : <div />}
      {!isRes ? InnerStrip : <div />}
    </div>
  );
}

function CombinedTargetTile({
  label, value, tone, icon,
}: {
  label: string;
  value: number | null;
  tone: "bull" | "bear";
  icon: string;
}) {
  const t = V2_TONE[tone];
  return (
    <div
      className="flex flex-col items-center rounded-md border px-2 py-1"
      style={{ borderColor: t.border, background: t.soft }}
    >
      <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-[0.16em]" style={{ color: t.color }}>
        <span>{icon}</span>
        {label}
      </span>
      <span className="mt-0.5 font-mono text-[18px] font-black tabular-nums leading-none" style={{ color: t.color }}>
        {value ? value.toLocaleString() : "—"}
      </span>
    </div>
  );
}

// 2.1 SPOT vs FUTURES (compact â€” col-span-2)
// function SpotVsFutures({ data }: { data: IntelV2Snapshot | null }) {
//   const spot = data?.spot.ltp ?? null;
//   const fut  = data?.futures.ltp ?? null;
//   const basis = data?.futures.premium ?? null;
//   const basisPct = (basis != null && spot) ? Number(((basis / spot) * 100).toFixed(2)) : null;
//   const tone = basis == null ? "neutral" : basis >= 0 ? "bull" : "bear";
//   const hint = data?.dashboard?.hints?.spotFut;
//   return (
//     <V2Card title="2.1 Spot vs Futures">
//       <div className="flex flex-col gap-1.5">
//         <div className="flex flex-col rounded-sm bg-white/[0.03] px-2 py-1">
//           <span className="text-[10px] uppercase tracking-wide text-white/45">Spot</span>
//           <span className="font-mono text-[15px] font-bold text-white">{v2Fmt(spot, 2)}</span>
//         </div>
//         <div className="flex flex-col rounded-sm bg-white/[0.03] px-2 py-1">
//           <span className="text-[10px] uppercase tracking-wide text-white/45">Futures</span>
//           <span className="font-mono text-[15px] font-bold text-white">{v2Fmt(fut, 2)}</span>
//         </div>
//         <div className="flex items-center justify-between rounded-sm bg-white/[0.03] px-2 py-1">
//           <span className="text-[10px] uppercase tracking-wide text-white/55">Basis</span>
//           <span className="font-mono text-[12px] font-bold" style={{ color: V2_TONE[tone].color }}>
//             {v2FmtSigned(basis ?? 0, 2)}
//           </span>
//         </div>
//         <div className="flex items-center justify-between rounded-sm bg-white/[0.03] px-2 py-1">
//           <span className="text-[10px] uppercase tracking-wide text-white/55">Basis %</span>
//           <span className="font-mono text-[12px] font-bold" style={{ color: V2_TONE[tone].color }}>
//             {basisPct != null ? `${basisPct >= 0 ? "+" : ""}${basisPct.toFixed(2)}%` : "â€”"}
//           </span>
//         </div>
//         <V2Pill
//           label={basis == null ? "â€”" : basis >= 0 ? "Premium" : "Discount"}
//           tone={tone as "bull" | "bear" | "neutral"}
//           size="sm"
//         />
//       </div>
//       <V2Hint label="Interpretation" tone={tone as "bull" | "bear" | "neutral"} text={hint || ""} />
//     </V2Card>
//   );
// }
// 
// 2.2 OI SHIFT (Active strikes) â€” LEGACY (commented out, replaced by WritingPressure below)
// /*
// function OiShift({ data }: { data: IntelV2Snapshot | null }) {
//   // ATM Â± 4 strikes, 100-spaced (backend already filters)
//   const rows = data?.dashboard?.oiHistogram || [];
//   const bias = data?.dashboard?.oiShiftBias;
// 
//   // Migration tag per row: PE Build / CE Build / Balanced
//   const migrationLabel = (ce: number, pe: number) => {
//     if (Math.abs(ce) < 1e3 && Math.abs(pe) < 1e3) return { label: "â€”", tone: "neutral" as const };
//     if (pe > ce && pe > 0) return { label: "PE Build", tone: "bull" as const };
//     if (ce > pe && ce > 0) return { label: "CE Build", tone: "bear" as const };
//     if (ce < 0 && pe > 0) return { label: "PE Build", tone: "bull" as const };
//     if (pe < 0 && ce > 0) return { label: "CE Build", tone: "bear" as const };
//     return { label: "Balanced", tone: "neutral" as const };
//   };
// 
//   // Bias bar colors
//   const biasTone = bias?.side === "CALL" ? "bull"
//     : bias?.side === "PUT" ? "bear" : "warn";
//   const sideLabel = bias?.side === "CALL" ? "CALL FAVOURED"
//     : bias?.side === "PUT" ? "PUT FAVOURED" : "BALANCED";
//   const sideColor = V2_TONE[biasTone].color;
//   const bullPct = bias?.bullishPct ?? 50;
//   const bearPct = bias?.bearishPct ?? 50;
// 
//   return (
//     <V2Card title="2.2 OI Shift (Active Strikes)">
//       <div className="-m-1.5 flex min-h-0 flex-1 flex-col overflow-y-auto p-1.5 pr-2">
//       <div className="grid grid-cols-[58px_60px_60px_60px_1fr] items-center gap-1 px-1 pb-1 text-[10px] font-bold uppercase tracking-wider text-white/45">
//         <span>Strike</span>
//         <span className="text-center">CE</span>
//         <span className="text-center">PE</span>
//         <span className="text-right">Migration</span>
//         <span className="pl-1 text-right">Buyer Favor</span>
//       </div>
//       <div className="flex flex-col gap-1">
//         {[...rows].sort((a, b) => b.strike - a.strike).map((r) => {
//           const ceTone = r.ceOiChg >= 0 ? "bear" : "bull";
//           const peTone = r.peOiChg >= 0 ? "bull" : "bear";
//           const mig = migrationLabel(r.ceOiChg, r.peOiChg);
//           const cePct = r.ceFavorPct ?? 50;
//           const pePct = r.peFavorPct ?? 50;
//           const fav = r.favorSide || "NEUTRAL";
//           const favColor = fav === "CE" ? V2_TONE.bull.color
//                          : fav === "PE" ? V2_TONE.bear.color
//                          : V2_TONE.warn.color;
//           return (
//             <div
//               key={r.strike}
//               className="grid grid-cols-[58px_60px_60px_60px_1fr] items-center gap-1 rounded-sm px-1.5 py-1 text-[12px]"
//               style={{ background: r.isAtm ? "rgba(59,130,246,0.10)" : "transparent" }}
//             >
//               <span className="font-mono font-bold text-white/90">
//                 {r.strike}{r.isAtm ? <span className="ml-1 text-[9px] text-sky-300">ATM</span> : null}
//               </span>
//               <span className="text-center font-mono" style={{ color: V2_TONE[ceTone].color }}>
//                 {v2FmtSignedCompact(r.ceOiChg)}
//               </span>
//               <span className="text-center font-mono" style={{ color: V2_TONE[peTone].color }}>
//                 {v2FmtSignedCompact(r.peOiChg)}
//               </span>
//               <span className="text-right">
//                 <V2Pill label={mig.label} tone={mig.tone} size="xs" />
//               </span>
//               {/* Buyer Favor meter â€” CE green vs PE red split */}
//               <div className="flex items-center gap-1.5 pl-1">
//                 <div className="relative flex h-2 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
//                   <div className="h-full bg-emerald-500/80" style={{ width: `${cePct}%` }} />
//                   <div className="h-full bg-rose-500/80" style={{ width: `${pePct}%` }} />
//                 </div>
//                 <span
//                   className="w-12 shrink-0 text-right font-mono text-[10px] font-bold tabular-nums"
//                   style={{ color: favColor }}
//                   title={`CE-buy ${r.ceBuyScore ?? 0}/100 vs PE-buy ${r.peBuyScore ?? 0}/100`}
//                 >
//                   {fav === "NEUTRAL" ? "â€”" : `${fav} ${r.favorPct ?? 0}%`}
//                 </span>
//               </div>
//             </div>
//           );
//         })}
//         {!rows.length ? (
//           <div className="px-1 py-3 text-center text-[12px] text-white/45">No data</div>
//         ) : null}
//       </div>
// 
//       {/* Bias verdict â€” which side favours + % */}
//       <div className="mt-2 flex flex-col gap-1.5 rounded-sm border border-white/[0.06] bg-white/[0.03] px-2.5 py-2">
//         <div className="flex items-center justify-between text-[11px]">
//           <span className="font-bold uppercase tracking-wider" style={{ color: sideColor }}>
//             {sideLabel}
//           </span>
//           <span className="font-mono font-bold tabular-nums" style={{ color: sideColor }}>
//             {bias?.pctFavour ?? 0}%
//           </span>
//         </div>
//         {/* Two-segment bar â€” green (bullish flow) vs red (bearish flow) */}
//         <div className="flex h-2 overflow-hidden rounded-full bg-white/[0.06]">
//           <div className="h-full bg-emerald-500/80" style={{ width: `${bullPct}%` }} />
//           <div className="h-full bg-rose-500/80" style={{ width: `${bearPct}%` }} />
//         </div>
//         <div className="flex items-center justify-between text-[10px]">
//           <span className="text-emerald-400">Bullish {bullPct}%</span>
//           <span className="text-rose-400">Bearish {bearPct}%</span>
//         </div>
//       </div>
// 
//       {/* Trend block â€” direction, strength, dominant strike, build counts */}
//       {bias?.trend ? (() => {
//         const t = bias.trend;
//         const dirTone = t.direction === "BULLISH" ? "bull"
//           : t.direction === "BEARISH" ? "bear" : "warn";
//         const dirColor = V2_TONE[dirTone].color;
//         const dirArrow = t.direction === "BULLISH" ? "â–²"
//           : t.direction === "BEARISH" ? "â–¼" : "â–¬";
//         const strengthTone = t.strength === "STRONG" ? "bull"
//           : t.strength === "MODERATE" ? "warn" : "neutral";
//         return (
//           <div className="mt-1.5 flex flex-col gap-1 rounded-sm border border-white/[0.06] bg-white/[0.025] px-2.5 py-1.5">
//             <div className="flex items-center justify-between">
//               <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider"
//                     style={{ color: dirColor }}>
//                 <span className="text-[14px] leading-none">{dirArrow}</span>
//                 {t.direction} TREND
//               </span>
//               <V2Pill label={t.strength} tone={strengthTone as "bull" | "warn" | "neutral"} size="xs" />
//             </div>
//             {/* Momentum bar 0..100 */}
//             <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
//               <div
//                 className="absolute inset-y-0 left-0"
//                 style={{ width: `${Math.min(100, t.momentum)}%`, background: dirColor }}
//               />
//             </div>
//             <div className="flex items-center justify-between text-[10px] text-white/65">
//               <span>Momentum</span>
//               <span className="font-mono font-bold" style={{ color: dirColor }}>
//                 {t.momentum}%
//               </span>
//             </div>
//             {t.dominantStrike != null ? (
//               <div className="flex items-center justify-between text-[10px]">
//                 <span className="text-white/55">Dominant</span>
//                 <span className="font-mono font-bold text-white/85">
//                   {t.dominantStrike}{" "}
//                   <span style={{
//                     color: t.dominantBuild?.startsWith("PE") ? "#22c55e" : "#ef4444",
//                   }}>
//                     {t.dominantBuild}
//                   </span>
//                 </span>
//               </div>
//             ) : null}
//             <div className="flex items-center justify-between text-[10px] text-white/55">
//               <span className="text-emerald-400">PE Build Ã— {t.putBuildCount}</span>
//               <span className="text-rose-400">CE Build Ã— {t.callBuildCount}</span>
//             </div>
//           </div>
//         );
//       })() : null}
// 
//       <V2Hint
//         label={bias?.trend?.direction === "BULLISH" ? "Bullish Trend"
//               : bias?.trend?.direction === "BEARISH" ? "Bearish Trend"
//               : "Trend"}
//         text={bias?.trend?.label || bias?.label || "Balanced"}
//         tone={biasTone as "bull" | "bear" | "warn"}
//       />
//       </div>
//     </V2Card>
//   );
// }
// */
// 
// 2.2 WRITING PRESSURE (Call resistance + Put support) â€” new card
// Replicates the Sensibull-style "Call Writing Pressure" / "Put Writing
// Support" stacked panels: top-5 strikes per side ranked by absolute OI
// build, with a 7-segment strength bar and a writer-activity footer.
function WritingPressure({ data }: { data: IntelV2Snapshot | null }) {
  const ana = data?.dashboard?.oiBuildupAnalysis;
  const atm = data?.options?.atm;
  if (!ana || !atm) {
    return (
      <V2Card title="2.2 Writing Pressure (Resistance & Support)">
        <div className="flex h-full items-center justify-center text-[12px] text-white/40">
          No OI buildup data
        </div>
      </V2Card>
    );
  }
  // 100-step + ATM ± 6 filter — same rule as CombinedWritingPressureBody.
  const anchor = Math.round(atm / 100) * 100;
  const lo = anchor - 6 * 100;
  const hi = anchor + 6 * 100;
  const isClean = (k: number) => k % 100 === 0 && k >= lo && k <= hi;

  // Pick top-6 CE strikes ABOVE/AT ATM ranked by |Î”OI| (resistance ladder).
  // Pick top-6 PE strikes BELOW/AT ATM ranked by |Î”OI| (support ladder).
  const ceStrikes = [...ana.ceTable]
    .filter(r => isClean(r.strike) && r.strike >= anchor)
    .sort((a, b) => Math.abs(b.oiChange) - Math.abs(a.oiChange))
    .slice(0, 6)
    .sort((a, b) => b.strike - a.strike);
  const peStrikes = [...ana.peTable]
    .filter(r => isClean(r.strike) && r.strike <= anchor)
    .sort((a, b) => Math.abs(b.oiChange) - Math.abs(a.oiChange))
    .slice(0, 6)
    .sort((a, b) => b.strike - a.strike);

  // CE writer activity score â€” sum of % build across the top resistance strikes.
  const ceTotalPct = ceStrikes.reduce((s, r) => s + Math.max(0, r.oiChangePct), 0);
  const peTotalPct = peStrikes.reduce((s, r) => s + Math.max(0, r.oiChangePct), 0);
  const ceActivity = ceTotalPct >= 250 ? "Aggressive"
    : ceTotalPct >= 120 ? "Active"
      : ceTotalPct >= 50 ? "Moderate" : "Light";
  const peActivity = peTotalPct >= 250 ? "Aggressive"
    : peTotalPct >= 120 ? "Active"
      : peTotalPct >= 50 ? "Moderate" : "Light";

  // Resistance / support range â€” min..max strike of the top entries.
  const ceLo = ceStrikes.length ? Math.min(...ceStrikes.map(r => r.strike)) : null;
  const ceHi = ceStrikes.length ? Math.max(...ceStrikes.map(r => r.strike)) : null;
  const peLo = peStrikes.length ? Math.min(...peStrikes.map(r => r.strike)) : null;
  const peHi = peStrikes.length ? Math.max(...peStrikes.map(r => r.strike)) : null;

  return (
    <V2Card title="2.2 Writing Pressure (Resistance & Support)">
      <div className="-m-1.5 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-1.5 pr-2">
        {/* Side-by-side panels: CE (left) | PE (right) */}
        <div className="grid min-h-0 grid-cols-2 gap-2">
          <WritingPanel
            side="CE"
            rows={ceStrikes}
            activity={ceActivity}
            rangeLo={ceLo}
            rangeHi={ceHi}
          />
          <WritingPanel
            side="PE"
            rows={peStrikes}
            activity={peActivity}
            rangeLo={peLo}
            rangeHi={peHi}
          />
        </div>
        {/* Bottom: Best Trade Pick â€” COMMENTED OUT
            (already shown in the top tradeBoard row above; keeping it here
            is duplicate). To re-enable, uncomment the line below. */}
        {/* <BestTradePickStrip data={data} /> */}
      </div>
    </V2Card>
  );
}

// Best Trade Pick footer — fuses verdict + FRVP + acceptance + delta + health
// + OI + trap to produce CE/PE picks with confluence-based probability.
function BestTradePickStrip({ data }: { data: IntelV2Snapshot | null }) {
  const pick = data?.dashboard?.bestTradePick;
  if (!pick) {
    return (
      <div className="rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px] text-white/45">
        Best Trade Pick — awaiting data
      </div>
    );
  }
  const { ce, pe, primary, spread } = pick;
  const verdictText = primary === "NEUTRAL"
    ? "BALANCED — wait for breakout"
    : `${primary} BIAS — edge ${spread} pts`;
  const verdictColor = primary === "CE" ? "#22c55e" : primary === "PE" ? "#ef4444" : "#facc15";

  return (
    <div className="rounded-md border border-white/[0.08] bg-gradient-to-br from-sky-500/[0.04] to-purple-500/[0.04] px-3 py-2.5">
      {/* Header */}
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-sky-300">
          🎯 Best Trade Pick
        </span>
        <span
          className="rounded-sm px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
          style={{ background: `${verdictColor}22`, color: verdictColor }}
        >
          {verdictText}
        </span>
      </div>

      {/* Two strike cards — CE | PE */}
      <div className="grid grid-cols-2 gap-2">
        <PickCard pick={ce} highlighted={primary === "CE"} />
        <PickCard pick={pe} highlighted={primary === "PE"} />
      </div>
    </div>
  );
}

type BestPick = {
  side: "CE" | "PE";
  strike: number;
  ltp: number;
  oi: number;
  delta: number;
  iv: number;
  health: { state: string; score: number };
  moneyness: string;
  probability: number;
  action: "STRONG BUY" | "BUY" | "CAUTIOUS BUY" | "WAIT" | "AVOID";
  label: string;
  reasoning: string;
  factors: Record<string, number>;
};

function PickCard({ pick, highlighted }: { pick: BestPick | null; highlighted: boolean }) {
  if (!pick) {
    return (
      <div className="rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px] text-white/45">
        — no candidate —
      </div>
    );
  }
  const isCE = pick.side === "CE";
  const accent = isCE ? "#22c55e" : "#ef4444";
  const probColor =
    pick.probability >= 70 ? "#22c55e"
      : pick.probability >= 60 ? "#84cc16"
        : pick.probability >= 50 ? "#facc15"
          : pick.probability >= 40 ? "#f97316"
            : "#ef4444";
  const actionTone =
    pick.action === "STRONG BUY" ? "bull"
      : pick.action === "BUY" ? "bull"
        : pick.action === "CAUTIOUS BUY" ? "warn"
          : pick.action === "WAIT" ? "warn"
            : "bear";

  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border px-3 py-2"
      style={{
        borderColor: highlighted ? accent : "rgba(255,255,255,0.08)",
        background: highlighted ? `${accent}10` : "rgba(255,255,255,0.02)",
        boxShadow: highlighted ? `0 0 0 1px ${accent}55, inset 0 0 12px ${accent}10` : undefined,
      }}
    >
      {/* Title row — strike + side + action pill */}
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2">
          <span
            className="font-mono text-[16px] font-bold tabular-nums"
            style={{ color: accent }}
          >
            BUY {pick.side} {pick.strike}
          </span>
          <span className="rounded-sm bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white/65">
            {pick.moneyness}
          </span>
        </span>
        <V2Pill label={pick.action} tone={actionTone as "bull" | "bear" | "warn"} size="xs" />
      </div>

      {/* Probability bar */}
      <div className="flex flex-col gap-0.5">
        <div className="flex items-baseline justify-between text-[10px]">
          <span className="font-bold uppercase tracking-wider text-white/55">Win Probability</span>
          <span className="font-mono text-[18px] font-bold tabular-nums" style={{ color: probColor }}>
            {pick.probability}%
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.08]">
          <div
            className="h-full transition-all"
            style={{ width: `${pick.probability}%`, background: probColor }}
          />
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-1 text-[10px]">
        <Stat label="LTP" value={pick.ltp.toFixed(2)} mono />
        <Stat label="Δ" value={pick.delta.toFixed(2)} mono />
        <Stat label="IV" value={pick.iv.toFixed(0) + "%"} mono />
        <Stat label="OI" value={`${(pick.oi / 1e5).toFixed(1)}L`} mono />
      </div>

      {/* Reasoning */}
      <div className="rounded-sm bg-white/[0.03] px-2 py-1 text-[10px] text-white/70">
        <span className="font-bold uppercase tracking-wider text-white/45">Why · </span>
        {pick.reasoning}
      </div>
    </div>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col rounded-sm bg-white/[0.04] px-1.5 py-1">
      <span className="text-[8px] font-bold uppercase tracking-wider text-white/45">{label}</span>
      <span className={`${mono ? "font-mono" : ""} text-[11px] font-bold tabular-nums text-white/90`}>
        {value}
      </span>
    </div>
  );
}

// One side of the writing-pressure card (CE = red resistance / PE = green support)
function WritingPanel({
  side, rows, activity, rangeLo, rangeHi,
}: {
  side: "CE" | "PE";
  rows: Array<{
    strike: number; oiToday: number; oiChange: number;
    oiChangePct: number; interpretation: string; isAtm: boolean;
  }>;
  activity: string;
  rangeLo: number | null;
  rangeHi: number | null;
}) {
  const isCE = side === "CE";
  const accent = isCE ? "#ef4444" : "#22c55e";
  const accentSoft = isCE ? "rgba(239,68,68,0.06)" : "rgba(34,197,94,0.06)";
  const accentBorder = isCE ? "rgba(239,68,68,0.30)" : "rgba(34,197,94,0.30)";
  const icon = isCE ? "" : "";
  const titleText = isCE ? "CALL WRITING PRESSURE (RESISTANCE)" : "PUT WRITING SUPPORT (SUPPORT)";
  const writerLabel = isCE ? "CALL WRITER ACTIVITY" : "PUT WRITER ACTIVITY";
  const hint = isCE
    ? "CE writers actively defending upside."
    : "PE writers providing decent support.";
  const zoneLabel = isCE ? "Strong supply zone between" : "Strong base between";

  // Find the strongest row (used for the highlighted ring) â€” biggest %change
  const dominantStrike = rows.length
    ? rows.reduce((a, b) => Math.abs(b.oiChangePct) > Math.abs(a.oiChangePct) ? b : a).strike
    : null;

  // Tag mapper â€” escalate "Strong Buildup" â†’ "Extreme CE Wall" / "Major Support" / etc.
  const interpretFor = (pct: number, position: number) => {
    if (isCE) {
      if (pct >= 50 && position === 0) return "Extreme CE Wall";
      if (pct >= 50) return "Very Strong";
      if (pct >= 30) return "Strong Resistance";
      if (pct >= 15) return "Resistance";
      if (pct >= 5) return "Moderate";
      if (pct <= -10) return "Unwinding";
      return "Stable";
    } else {
      if (pct >= 50 && position === 0) return "Major Support";
      if (pct >= 30) return "Strong Support";
      if (pct >= 15) return "Immediate Support";
      if (pct >= 5) return "Moderate";
      if (pct <= -10) return "Weakening";
      return "Weak Support";
    }
  };

  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border px-2.5 py-2"
      style={{ borderColor: accentBorder, background: accentSoft }}
    >
      {/* Title */}
      <div className="flex items-center gap-2">
        <span className="text-[14px] leading-none">{icon}</span>
        <span className="text-[11px] font-bold uppercase tracking-[0.16em]" style={{ color: accent }}>
          {titleText}
        </span>
      </div>

      {/* Header row */}
      <div className="grid grid-cols-[64px_72px_56px_88px_1fr] items-center gap-2 px-1 text-[9px] font-bold uppercase tracking-wider text-white/45">
        <span>Strike</span>
        <span>OI Buildup</span>
        <span>Change</span>
        <span>Strength</span>
        <span>Interpretation</span>
      </div>

      {/* Rows */}
      <div className="flex flex-col gap-0.5">
        {rows.length === 0 ? (
          <div className="px-1 py-3 text-center text-[11px] text-white/45">No data</div>
        ) : null}
        {rows.map((r, i) => {
          const pctClamped = Math.min(100, Math.max(0, Math.abs(r.oiChangePct)));
          // 7-segment strength bar
          const filledSegments = Math.round((pctClamped / 100) * 7);
          const interpretation = interpretFor(r.oiChangePct, i);
          const isDominant = r.strike === dominantStrike;
          const isAtmRow = r.isAtm;
          // Lakh formatting â€” divide by 1e5
          const oiInLakh = (r.oiChange / 1e5);
          const oiSign = oiInLakh >= 0 ? "+" : "";
          const pctSign = r.oiChangePct >= 0 ? "+" : "";
          // ATM gets a sky-blue tone overriding the side accent.
          const ATM_BLUE = "#38bdf8";
          const ATM_BLUE_SOFT = "rgba(56,189,248,0.10)";
          const ATM_BLUE_BORDER = "rgba(56,189,248,0.55)";
          const rowBorder = isAtmRow ? ATM_BLUE_BORDER : isDominant ? accent : "transparent";
          const rowBg = isAtmRow ? ATM_BLUE_SOFT : isDominant ? accentSoft : "transparent";
          return (
            <div
              key={r.strike}
              className="grid grid-cols-[64px_72px_56px_88px_1fr] items-center gap-2 rounded-sm px-1 py-1 text-[12px]"
              style={{
                border: `1px solid ${rowBorder}`,
                background: rowBg,
              }}
            >
              <span
                className="font-mono font-bold tabular-nums"
                style={{ color: isAtmRow ? ATM_BLUE : "rgba(255,255,255,0.9)" }}
              >
                {r.strike.toLocaleString()}
                {isAtmRow ? (
                  <span
                    className="ml-1 rounded-sm px-1 text-[8px] font-bold"
                    style={{ background: "rgba(56,189,248,0.20)", color: ATM_BLUE }}
                  >
                    ATM
                  </span>
                ) : null}
              </span>
              <span className="font-mono tabular-nums text-white/85">
                {oiSign}{oiInLakh.toFixed(2)} L
              </span>
              <span className="font-mono font-bold tabular-nums" style={{ color: accent }}>
                {pctSign}{r.oiChangePct.toFixed(1)}%
              </span>
              {/* 7-segment bar */}
              <span className="flex items-center gap-[2px]">
                {Array.from({ length: 7 }).map((_, idx) => (
                  <span
                    key={idx}
                    className="block h-2.5 w-2"
                    style={{
                      background: idx < filledSegments ? accent : "rgba(255,255,255,0.12)",
                      borderRadius: 1,
                    }}
                  />
                ))}
              </span>
              <span className="text-[11px] tabular-nums" style={{ color: accent }}>
                {interpretation}
              </span>
            </div>
          );
        })}
      </div>

      {/* Footer: writer activity + zone summary */}
      <div
        className="mt-1 grid grid-cols-[140px_1fr] items-start gap-3 rounded-sm border px-2 py-1.5 text-[10px]"
        style={{ borderColor: accentBorder, background: accentSoft }}
      >
        <div className="flex flex-col gap-0.5">
          <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: accent }}>
            {writerLabel}
          </span>
          <span className="text-[14px] font-bold" style={{ color: accent }}>
            {activity}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 text-white/65">
          <span>{hint}</span>
          {rangeLo != null && rangeHi != null ? (
            <span>
              {zoneLabel}{" "}
              <span className="font-mono font-bold" style={{ color: accent }}>
                {rangeLo.toLocaleString()} â€“ {rangeHi.toLocaleString()}
              </span>
              .
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// 2.5 FRVP (Institutional Map) â€” replicates the screenshot exactly
function FrvpInstitutional({ data }: { data: IntelV2Snapshot | null }) {
  const f = data?.dashboard?.frvpInstitutional;
  if (!f) {
    return (
      <V2Card title="2.5 FRVP (Institutional Map)">
        <div className="flex h-full items-center justify-center text-[12px] text-white/40">
          No volume profile yet
        </div>
      </V2Card>
    );
  }
  const e = f.engine;
  const markerLeft = `${100 - (e?.location?.markerPct ?? f.markerPct)}%`;

  // Tone resolution â€” engine drives if available, else legacy fallback
  const verdictTone = e?.interpretation?.tone === "bull" ? "bull"
    : e?.interpretation?.tone === "bear" ? "bear"
      : e?.interpretation?.tone === "neutral" ? "neutral" : "warn";

  // Top-line directional bias (Section 11)
  const dirBias = e?.directionalBias;
  const biasTone = dirBias?.side === "CE" ? "bull"
    : dirBias?.side === "PE" ? "bear" : "warn";
  const biasColor = V2_TONE[biasTone].color;

  // Acceptance / rejection signals
  const acc = e?.acceptance;
  const trap = e?.advanced?.trapped;
  const trapActive = !!trap;

  // Dominance
  const dom = e?.dominance;
  const buyersScore = dom?.buyersScore ?? Math.round((f.buyers.entering + (100 - f.sellers.entering)) / 2);
  const sellersScore = dom?.sellersScore ?? (100 - buyersScore);
  const domSide = dom?.dominantSide || (buyersScore >= 60 ? "BUYERS" : sellersScore >= 60 ? "SELLERS" : "BALANCED");
  const domTone = domSide === "BUYERS" ? "bull" : domSide === "SELLERS" ? "bear" : "warn";
  const domColor = V2_TONE[domTone].color;

  // Flow (CE / PE buyers separately for the meter)
  const ceBuyersPct = e?.flow?.ceBuyersPct ?? 50;
  const peBuyersPct = e?.flow?.peBuyersPct ?? 50;

  // Profile + advanced overlays
  const profile = e?.profile;
  const advanced = e?.advanced;

  return (
    <V2Card
      title={
        <span className="flex items-center gap-2">
          2.5 FRVP (Institutional Map)
          {trapActive ? (
            <span
              className="animate-pulse rounded-sm bg-rose-500/30 px-1.5 py-0.5 text-[10px] font-bold tracking-widest text-rose-300"
              title={trap?.detail}
            >
              âš  {trap?.side}
            </span>
          ) : null}
        </span>
      }
    >
      <div className="-m-1.5 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-1.5 pr-2">
        {/* â”€â”€ TOP STRIP â€” VAH / POC / VAL + gradient bar with marker + Spot status */}
        <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
          <div className="flex flex-col gap-1 text-[11px]">
            <Row label="VAH" value={v2Fmt(profile?.vah ?? f.vah, 0)} mono color="#9ca3af" />
            <Row label="POC" value={v2Fmt(profile?.poc ?? f.poc, 0)} mono color="#facc15" highlight />
            <Row label="VAL" value={v2Fmt(profile?.val ?? f.val, 0)} mono color="#9ca3af" />
          </div>
          <div className="relative flex h-14 flex-col items-stretch justify-center">
            <div className="mb-1 flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.16em]">
              <span className="text-emerald-400">CE Zone</span>
              <span className="text-white/55">
                {e?.location?.side === "above_value" ? "Above Value"
                  : e?.location?.side === "below_value" ? "Below Value"
                    : e?.location?.nearPOC ? "Near POC"
                      : "Inside Value"}
              </span>
              <span className="text-rose-400">PE Zone</span>
            </div>
            <div className="relative">
              <div
                className="h-2 w-full overflow-hidden rounded-full"
                style={{
                  background: "linear-gradient(90deg, rgba(34,197,94,0.45) 0%, rgba(34,197,94,0.18) 50%, rgba(239,68,68,0.18) 50%, rgba(239,68,68,0.45) 100%)",
                }}
              />
              <div className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: markerLeft }}>
                <div className="flex flex-col items-center">
                  <div className="h-4 w-0.5 bg-white/85" />
                  <div className="h-3 w-3 rounded-full border border-white bg-white shadow" />
                  <div className="h-4 w-0.5 bg-white/85" />
                </div>
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-1 text-[11px]">
            <Row label="Price" value={v2Fmt(f.price, 2)} mono color="#22c55e" />
            <Row label="Inside" value={f.insideValue} pillTone={f.insideValue === "YES" ? "bull" : "bear"} />
            <Row label="Outside" value={f.outsideValue} pillTone={f.outsideValue === "YES" ? "bull" : "bear"} />
          </div>
        </div>

        {/* â”€â”€ ACCEPTANCE / REJECTION ribbon â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {acc ? (
          <div className="mt-2 grid grid-cols-2 gap-1.5 text-[10px]">
            <AcceptTile
              label={`Above VAH ${profile?.vah ?? f.vah ?? "â€”"}`}
              accepted={acc.acceptedAboveVAH}
              rejected={acc.rejectedAboveVAH}
              bars={acc.consecutiveAbove}
              volumeSurge={acc.volumeSurgeAbove}
            />
            <AcceptTile
              label={`Below VAL ${profile?.val ?? f.val ?? "â€”"}`}
              accepted={acc.acceptedBelowVAL}
              rejected={acc.rejectedBelowVAL}
              bars={acc.consecutiveBelow}
              volumeSurge={acc.volumeSurgeBelow}
            />
          </div>
        ) : null}

        {/* â”€â”€ DIRECTIONAL BIAS for option buyers â€” promoted ABOVE the dominance row â”€ */}
        {dirBias ? (
          <div
            className="mt-2 flex flex-col gap-0.5 rounded-sm border px-2.5 py-1.5"
            style={{ borderColor: `${biasColor}55`, background: `${biasColor}10` }}
          >
            <div className="flex items-center justify-between text-[12px]">
              <span className="flex items-center gap-2 font-bold uppercase tracking-[0.14em]" style={{ color: biasColor }}>
                {dirBias.side === "CE" ? `BUY CE ${dirBias.targetStrike ?? ""}`
                  : dirBias.side === "PE" ? `BUY PE ${dirBias.targetStrike ?? ""}`
                    : "WAIT"}
                <V2Pill label={dirBias.strength} tone={biasTone as "bull" | "bear" | "warn"} size="xs" />
              </span>
              <span className="text-[10px] text-white/65">{dirBias.reason}</span>
            </div>
          </div>
        ) : null}

        {/* â”€â”€ BUYERS / SELLERS / PARTICIPATION grid â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
          <div className="rounded-sm border border-emerald-500/20 bg-emerald-500/[0.04] px-2 py-1.5">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-emerald-400">BUYERS</div>
            <CompactPair label="Entering" value={`${f.buyers.entering}%`} valueColor="#22c55e" />
            <CompactPair label="CE Side" value={`${ceBuyersPct.toFixed(0)}%`} valueColor="#22c55e" />
            {e?.flow?.dominantCeBuyStrike != null ? (
              <CompactPair label="CE Strike" value={String(e.flow.dominantCeBuyStrike)} valueColor="#22c55e" />
            ) : null}
          </div>
          <div className="rounded-sm border border-rose-500/20 bg-rose-500/[0.04] px-2 py-1.5">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-rose-400">SELLERS</div>
            <CompactPair label="Entering" value={`${f.sellers.entering}%`} valueColor="#ef4444" />
            <CompactPair label="PE Side" value={`${peBuyersPct.toFixed(0)}%`} valueColor="#ef4444" />
            {e?.flow?.dominantPeBuyStrike != null ? (
              <CompactPair label="PE Strike" value={String(e.flow.dominantPeBuyStrike)} valueColor="#ef4444" />
            ) : null}
          </div>
          <div className="rounded-sm border border-sky-500/20 bg-sky-500/[0.04] px-2 py-1.5">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-sky-300">PARTICIPATION</div>
            <CompactPair label="Strike" value={f.participationStrike?.toString() || "â€”"} valueColor="#fff" />
            <CompactPair
              label="Strength"
              value={profile ? `${profile.profileStrength.toFixed(0)}%` : f.participationLevel || "â€”"}
              valueColor={profile ? (profile.profileStrength >= 35 ? "#22c55e" : profile.profileStrength <= 15 ? "#ef4444" : "#facc15") : "#facc15"}
            />
            {advanced?.gammaWall ? (
              <CompactPair label="Î³ Wall" value={String(advanced.gammaWall.strike)} valueColor="#a855f7" />
            ) : null}
          </div>
        </div>

        {/* â”€â”€ DOMINANCE METER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        <div className="mt-2 flex flex-col gap-1.5 rounded-sm border border-white/[0.06] bg-white/[0.03] px-2.5 py-2">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-bold uppercase tracking-wider" style={{ color: domColor }}>
              {domSide === "BUYERS" ? `BUYERS DOMINATING${e?.flow?.dominantCeBuyStrike != null ? ` (CE ${e.flow.dominantCeBuyStrike})` : ""}`
                : domSide === "SELLERS" ? `SELLERS DOMINATING${e?.flow?.dominantPeBuyStrike != null ? ` (PE ${e.flow.dominantPeBuyStrike})` : ""}`
                  : "BALANCED FLOW"}
            </span>
            <span className="flex items-center gap-1.5 font-mono font-bold tabular-nums" style={{ color: domColor }}>
              {Math.round(Math.max(buyersScore, sellersScore))}%
              {dom?.conviction === "high"
                ? <span className="rounded-sm bg-emerald-500/20 px-1.5 py-0.5 text-[9px] tracking-wider text-emerald-300">CONFIRMED</span>
                : dom?.conviction === "divergent"
                  ? <span className="rounded-sm bg-amber-500/20 px-1.5 py-0.5 text-[9px] tracking-wider text-amber-300">DIVERGENT</span>
                  : null}
            </span>
          </div>
          <div className="flex h-2 overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full bg-emerald-500/80" style={{ width: `${buyersScore}%` }} />
            <div className="h-full bg-rose-500/80" style={{ width: `${sellersScore}%` }} />
          </div>
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-emerald-400">Buyers {Math.round(buyersScore)}%</span>
            <span className="text-white/45 font-mono">
              Î” {e?.delta?.deltaPct != null ? `${e.delta.deltaPct >= 0 ? "+" : ""}${e.delta.deltaPct.toFixed(1)}%` : "â€”"}
            </span>
            <span className="text-rose-400">Sellers {Math.round(sellersScore)}%</span>
          </div>
          <div className="text-center text-[9px] uppercase tracking-[0.18em] text-white/35">
            Buyer Dominant Flow Estimate Â· Not Orderbook Tape
          </div>
        </div>

        {/* â”€â”€ ADVANCED OVERLAYS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {advanced ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
            {advanced.gammaWall ? (
              <Badge label="Gamma Wall" value={String(advanced.gammaWall.strike)} tone="purple" />
            ) : null}
            {advanced.premiumVel ? (
              <Badge
                label="Premium"
                value={advanced.premiumVel.state.replace("_", " ")}
                tone={advanced.premiumVel.state === "CE_EXPANDING" ? "bull"
                  : advanced.premiumVel.state === "PE_EXPANDING" ? "bear" : "warn"}
              />
            ) : null}
            {advanced.nakedPOC ? (
              <Badge label="Naked POC" value={String(advanced.nakedPOC.price)} tone="info" />
            ) : null}
            {advanced.developingPOC && advanced.developingPOC.length >= 2 ? (
              <Badge
                label="POC Trail"
                value={(() => {
                  const arr = advanced.developingPOC;
                  const start = arr[0].poc;
                  const end = arr[arr.length - 1].poc;
                  return end > start ? "â†‘ Migrating Up"
                    : end < start ? "â†“ Migrating Down"
                      : "â†’ Flat";
                })()}
                tone={(() => {
                  const arr = advanced.developingPOC;
                  const start = arr[0].poc;
                  const end = arr[arr.length - 1].poc;
                  return end > start ? "bull" : end < start ? "bear" : "neutral";
                })()}
              />
            ) : null}
          </div>
        ) : null}

        <V2Hint
          label={e?.interpretation?.verdict?.replace(/_/g, " ") || "Interpretation"}
          text={e?.interpretation?.summary || f.interpretation}
          tone={verdictTone as "bull" | "bear" | "warn" | "neutral"}
        />
      </div>
    </V2Card>
  );
}

// â”€â”€ Small helpers used by the FRVP card â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function AcceptTile({
  label, accepted, rejected, bars, volumeSurge,
}: {
  label: string;
  accepted: boolean;
  rejected: boolean;
  bars: number;
  volumeSurge: boolean;
}) {
  let state = "Probing";
  let tone: "bull" | "bear" | "warn" | "neutral" = "neutral";
  if (rejected) { state = "Rejected"; tone = "bear"; }
  else if (accepted) { state = "Accepted"; tone = "bull"; }
  else if (bars > 0) { state = `${bars} bar${bars > 1 ? "s" : ""}`; tone = "warn"; }
  return (
    <div
      className="flex items-center justify-between rounded-sm border px-2 py-1.5"
      style={{ borderColor: V2_TONE[tone].border, background: V2_TONE[tone].soft }}
    >
      <span className="text-[10px] font-bold uppercase tracking-wider text-white/65">{label}</span>
      <span className="flex items-center gap-1 text-[10px] font-bold tabular-nums" style={{ color: V2_TONE[tone].color }}>
        {state}
        {volumeSurge ? <span className="rounded-sm bg-white/[0.08] px-1 text-[9px]">Volâ†‘</span> : null}
      </span>
    </div>
  );
}

function Badge({ label, value, tone }: { label: string; value: string; tone: "bull" | "bear" | "warn" | "info" | "purple" | "neutral" }) {
  const t = V2_TONE[tone];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5"
      style={{ borderColor: t.border, background: t.soft }}
    >
      <span className="text-[9px] uppercase tracking-wider text-white/55">{label}</span>
      <span className="font-mono text-[10px] font-bold" style={{ color: t.color }}>{value}</span>
    </span>
  );
}

function Row({
  label, value, mono, highlight, pillTone, color,
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
  pillTone?: "bull" | "bear" | "warn" | "neutral";
  color?: string;
}) {
  return (
    <div className={`flex items-center justify-between gap-2 ${highlight ? "rounded-sm bg-amber-400/10 px-1" : ""}`}>
      <span className="text-[10px] uppercase tracking-wide text-white/55">{label}</span>
      {pillTone ? (
        <V2Pill label={value} tone={pillTone} size="xs" />
      ) : (
        <span
          className={`${mono ? "font-mono" : ""} text-[12px] font-bold tabular-nums`}
          style={{ color: color || "#e5e7eb" }}
        >
          {value}
        </span>
      )}
    </div>
  );
}

// Compact label+value pair â€” tighter horizontal spacing for FRVP grid
function CompactPair({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="flex items-baseline gap-1.5 py-0.5 text-[11px]">
      <span className="text-white/55">{label}</span>
      <span className="ml-auto font-mono font-bold tabular-nums" style={{ color: valueColor || "#fff" }}>{value}</span>
    </div>
  );
}
