import type { IntelV2Snapshot, TradeBoardSetup } from "@/lib/intelV2Types";
import { V2Card, V2Pill, V2_TONE, v2Fmt } from "./common";

/**
 * Row 1b — TRADE BOARD
 * ========================================================================
 * Lifted from /intel-v3 and slotted into /intel-v2 right under the master
 * decision row. Shows 4 quick-glance cards:
 *
 *   1. Best Option Buy        — primary recommendation (CE or PE)
 *   2. Alternate Scenario     — opposite-side pick if primary fails
 *   3. Risk Gauge             — overall trap risk + confidence + bias gap
 *   4. Execution Context      — auction phase + next level + key levels
 */
export function Row1bTradeBoard({ data }: { data: IntelV2Snapshot | null }) {
  const tb = data?.dashboard?.tradeBoard;
  if (!tb) {
    return (
      <div className="rounded-md border border-white/[0.06] bg-white/[0.02] p-3 text-[12px] text-white/45">
        Trade Board · awaiting data
      </div>
    );
  }
  return (
    <div className="grid h-[290px] grid-cols-12 gap-2">
      <div className="col-span-4 min-h-0">
        <SetupCard title="Best Option Buy" subtitle="(High Probability)" icon="🎯" data={tb.bestOptionBuy} />
      </div>
      <div className="col-span-4 min-h-0">
        <SetupCard title="Alternate Scenario" subtitle="(If Reversal)" icon="🔁" data={tb.alternateScenario} />
      </div>
      <div className="col-span-4 min-h-0">
        {/* Buyers vs Sellers donut moved INTO 2.5 FRVP Institutional Map.
            Smart Money Flow card moved to its own full-width row below.
            This slot now hosts the Execution Context tile back. */}
        <ExecutionContextCard ctx={tb.executionContext} />
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * Setup card — used for both Best Option Buy + Alternate Scenario
 * ───────────────────────────────────────────────────────────────────── */
function SetupCard({
  title, subtitle, icon, data,
}: {
  title: string;
  subtitle?: string;
  icon: string;
  data: TradeBoardSetup | null;
}) {
  if (!data) {
    return (
      <V2Card title={<span>{icon} {title}</span>}>
        <div className="flex h-full items-center justify-center text-[11px] text-white/45">
          No setup yet
        </div>
      </V2Card>
    );
  }
  const accent = data.side === "CE" ? "bull" : "bear";
  const accentColor = V2_TONE[accent].color;

  return (
    <V2Card
      title={
        <span className="flex items-center gap-2">
          <span>{icon}</span>
          {title}
          {subtitle ? <span className="text-[9px] font-normal text-white/45">{subtitle}</span> : null}
        </span>
      }
      accent={accent}
    >
      <div className="-m-1.5 flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden p-1.5">
        {/* Reversal hint (alternate only) */}
        {data.reversalCondition ? (
          <div className="rounded-sm bg-white/[0.04] px-2 py-1 text-[9px] uppercase tracking-wider text-white/65">
            <span className="font-bold">If: </span>{data.reversalCondition}
          </div>
        ) : (
          <div className="text-center text-[9px] font-bold uppercase tracking-[0.18em] text-white/45">
            Recommended
          </div>
        )}

        {/* BIG title row */}
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-[28px] font-black leading-none tracking-[0.06em]" style={{ color: accentColor }}>
            BUY {data.side}
          </span>
          <span className="text-[12px] font-bold text-white/90">
            Strike: <span style={{ color: accentColor }}>{data.strike.toLocaleString()} {data.side}</span>
            <span className="ml-1.5 rounded-sm bg-white/[0.06] px-1 text-[8px] uppercase tracking-wider text-white/55">
              {data.moneyness}
            </span>
          </span>
          <span
            className="rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
            style={{ background: accentColor + "22", color: accentColor }}
          >
            {data.setupTag} · {data.probability}%
          </span>
        </div>

        {/* Confirm chips */}
        <div className="grid grid-cols-4 gap-1">
          {data.confirmChips.map((c, i) => {
            const t = V2_TONE[c.tone];
            return (
              <div
                key={i}
                className="flex flex-col items-center rounded-sm border px-1 py-1"
                style={{ borderColor: t.border, background: t.soft }}
              >
                <span className="text-[8px] font-bold uppercase tracking-wider text-white/55">{c.label}</span>
                <span
                  className="mt-0.5 truncate text-[10px] font-bold leading-tight"
                  style={{ color: t.color }}
                >
                  {c.value}
                </span>
              </div>
            );
          })}
        </div>

        {/* Targets */}
        {/* <div>
          <div className="mb-0.5 text-center text-[8px] font-bold uppercase tracking-[0.18em] text-white/55">
            Targets (Intraday)
          </div>
          <div className="grid grid-cols-3 gap-1">
            <TargetCell label="T1" value={data.targets.t1} accent={accentColor} />
            <TargetCell label="T2" value={data.targets.t2} accent={accentColor} />
            <TargetCell label="T3" value={data.targets.t3} accent={accentColor} />
          </div>
        </div> */}

        {/* SL */}
        {/* <div className="rounded-md border border-rose-500/30 bg-rose-500/[0.05] px-2 py-1 text-center">
          <div className="text-[8px] font-bold uppercase tracking-[0.18em] text-rose-300">SL (Stop Loss)</div>
          <div className="font-mono text-[12px] font-bold text-rose-400">
            {data.side === "CE" ? "Below" : "Above"} {data.stopLoss.toLocaleString()}
          </div>
        </div> */}

        {/* Why */}
        <div className="rounded-sm bg-white/[0.025] px-2 py-1 text-[9px] text-white/65">
          <span className="font-bold uppercase tracking-wider text-white/45">Why · </span>
          {data.reasoning}
        </div>
      </div>
    </V2Card>
  );
}

function TargetCell({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div
      className="flex flex-col items-center rounded-md border px-1 py-0.5"
      style={{ borderColor: accent + "44", background: accent + "10" }}
    >
      <span className="text-[8px] font-bold uppercase tracking-[0.18em] text-white/55">{label}</span>
      <span className="font-mono text-[12px] font-bold tabular-nums" style={{ color: accent }}>
        {value.toLocaleString()}
      </span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * Buyers vs Sellers Donut — replaces the Risk Gauge.
 * Sources from frvpInstitutional.engine.dominance (buyers/sellers score)
 * and frvpInstitutional.engine.delta (deltaPct + bias).
 * ───────────────────────────────────────────────────────────────────── */
function BuyersSellersDonut({ data }: { data: IntelV2Snapshot | null }) {
  const dom = data?.dashboard?.frvpInstitutional?.engine?.dominance;
  const delt = data?.dashboard?.frvpInstitutional?.engine?.delta;
  const buyers = Math.round(dom?.buyersScore ?? 50);
  const sellers = Math.round(dom?.sellersScore ?? 50);
  const dominant = dom?.dominantSide ?? "BALANCED";
  const isBuyers = dominant === "BUYERS";
  const isSellers = dominant === "SELLERS";
  const dominantPct = isBuyers ? buyers : isSellers ? sellers : Math.max(buyers, sellers);
  const dominantColor = isBuyers ? V2_TONE.bull.color : isSellers ? V2_TONE.bear.color : V2_TONE.warn.color;

  const buyersLabel = buyers >= 60 ? "Dominating" : buyers >= 45 ? "Balanced" : "Weak";
  const sellersLabel = sellers >= 60 ? "Dominating" : sellers >= 45 ? "Balanced" : "Weak";

  const deltaPct = delt?.deltaPct ?? 0;
  const deltaBias = delt?.bias ?? "neutral";
  const deltaColor = deltaBias === "bullish" ? V2_TONE.bull.color
    : deltaBias === "bearish" ? V2_TONE.bear.color
    : V2_TONE.warn.color;
  const deltaLabel = deltaBias === "bullish" ? "Positive"
    : deltaBias === "bearish" ? "Negative"
    : "Neutral";

  // Donut math — 2π × r
  const r = 36;
  const c = 2 * Math.PI * r;
  const buyersArc = (buyers / 100) * c;
  const sellersArc = (sellers / 100) * c;

  return (
    <V2Card title={<span>🥊 Buyers vs Sellers</span>}>
      <div className="-m-1.5 grid min-h-0 flex-1 grid-cols-[auto_1fr] items-center gap-2 p-1.5">
        {/* Donut */}
        <div className="relative h-[110px] w-[110px]">
          <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
            <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="10" />
            {/* Buyers arc — green, starts at top, sweeps clockwise for buyers% */}
            <circle
              cx="50" cy="50" r={r} fill="none"
              stroke={V2_TONE.bull.color} strokeWidth="10" strokeLinecap="butt"
              strokeDasharray={`${buyersArc} ${c}`}
              strokeDashoffset={0}
              style={{ transition: "stroke-dasharray 0.6s ease" }}
            />
            {/* Sellers arc — red, starts where buyers ends */}
            <circle
              cx="50" cy="50" r={r} fill="none"
              stroke={V2_TONE.bear.color} strokeWidth="10" strokeLinecap="butt"
              strokeDasharray={`${sellersArc} ${c}`}
              strokeDashoffset={-buyersArc}
              style={{ transition: "stroke-dashoffset 0.6s ease, stroke-dasharray 0.6s ease" }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-mono text-[20px] font-black leading-none" style={{ color: dominantColor }}>
              {dominantPct}%
            </span>
            <span className="mt-0.5 text-[8px] font-bold uppercase tracking-wider" style={{ color: dominantColor }}>
              {dominant === "BUYERS" ? "BUYERS" : dominant === "SELLERS" ? "SELLERS" : "BALANCED"}
            </span>
          </div>
        </div>

        {/* Right legend + delta */}
        <div className="flex flex-col gap-1.5 text-[10px]">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: V2_TONE.bear.color }} />
            <span className="font-bold text-white/80">Sellers</span>
            <span className="ml-auto font-mono font-bold tabular-nums" style={{ color: V2_TONE.bear.color }}>
              {sellers}%
            </span>
          </div>
          <span className="-mt-1 ml-3.5 text-[9px] text-white/55">- {sellersLabel}</span>

          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: V2_TONE.bull.color }} />
            <span className="font-bold text-white/80">Buyers</span>
            <span className="ml-auto font-mono font-bold tabular-nums" style={{ color: V2_TONE.bull.color }}>
              {buyers}%
            </span>
          </div>
          <span className="-mt-1 ml-3.5 text-[9px] text-white/55">- {buyersLabel}</span>

          <div className="my-0.5 h-px w-full bg-white/10" />

          <div className="flex flex-col">
            <span className="text-[8px] font-bold uppercase tracking-wider text-white/55">Delta</span>
            <span className="font-mono text-[14px] font-bold tabular-nums" style={{ color: deltaColor }}>
              {deltaPct >= 0 ? "+" : ""}{deltaPct.toFixed(2)}
            </span>
            <span className="text-[9px] font-bold" style={{ color: deltaColor }}>
              ({deltaLabel})
            </span>
          </div>
        </div>
      </div>
    </V2Card>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * Execution Context — auction phase + next level + key levels
 * ───────────────────────────────────────────────────────────────────── */
function ExecutionContextCard({ ctx }: { ctx: NonNullable<NonNullable<IntelV2Snapshot["dashboard"]["tradeBoard"]>["executionContext"]> }) {
  return (
    <V2Card title={<span>🎮 Execution Context</span>}>
      <div className="-m-1.5 flex min-h-0 flex-1 flex-col gap-1 overflow-hidden p-1.5">
        {/* Preferred action banner */}
        <div
          className="rounded-md border px-2 py-1 text-center"
          style={{ borderColor: V2_TONE[ctx.preferredTone].border, background: V2_TONE[ctx.preferredTone].soft }}
        >
          <span className="text-[8px] font-bold uppercase tracking-[0.16em] text-white/55">Preferred Action</span>
          <div className="font-mono text-[12px] font-bold leading-tight" style={{ color: V2_TONE[ctx.preferredTone].color }}>
            {ctx.preferredAction}
          </div>
        </div>

        {/* Phase + flow + VWAP — 3 inline chips */}
        <div className="grid grid-cols-3 gap-1">
          <MiniChip label="Phase" value={ctx.phase} tone="warn" />
          <MiniChip label="Flow"  value={ctx.flowState} tone={ctx.flowTone} />
          <MiniChip label="VWAP"  value={ctx.vwapState} tone={ctx.vwapTone} />
        </div>

        {/* Next level */}
        {ctx.nextLevel != null ? (
          <div className="flex items-center justify-between rounded-sm bg-white/[0.025] px-2 py-1 text-[10px]">
            <span className="text-white/55">{ctx.nextLevelLabel}</span>
            <span className="font-mono font-bold text-white/90">{ctx.nextLevel.toLocaleString()}</span>
          </div>
        ) : null}

        {/* Mini key levels grid */}
        <div className="grid grid-cols-2 gap-1">
          {ctx.keyLevels.map((l, i) => (
            <div key={i} className="rounded-sm bg-white/[0.025] px-1.5 py-0.5">
              <div className="text-[8px] font-bold uppercase tracking-wider text-white/45">{l.label}</div>
              <div className="font-mono text-[10px] font-bold tabular-nums text-white/85">
                {l.value != null ? v2Fmt(l.value, 2) : "—"}
              </div>
            </div>
          ))}
        </div>
      </div>
    </V2Card>
  );
}

function MiniChip({ label, value, tone }: { label: string; value: string; tone: "bull" | "bear" | "warn" | "neutral" }) {
  const t = V2_TONE[tone];
  return (
    <div
      className="flex flex-col items-center rounded-sm border px-0.5 py-0.5"
      style={{ borderColor: t.border, background: t.soft }}
    >
      <span className="text-[7px] font-bold uppercase tracking-wider text-white/55">{label}</span>
      <span className="truncate text-[9px] font-bold leading-tight" style={{ color: t.color }}>
        {value}
      </span>
    </div>
  );
}

// Tiny re-usable badge — kept for symmetry with rest of Row* files
export { Row1bTradeBoard as default };

// V2Pill is imported but only re-exported for parity; mark as used
export const _unused_V2Pill = V2Pill;
