import type { IntelSnapshot } from "@/lib/intelTypes";
import { Panel } from "./Panel";
import { cn } from "@/lib/utils";

function fmt(n: number | null | undefined, d = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

const HEALTH_COLORS: Record<string, string> = {
  explosive: "#10b981",
  healthy: "#22c55e",
  weak: "#f59e0b",
  dead: "#ef4444",
  unknown: "#6b7280",
};

function HealthBar({ score, color }: { score: number; color: string }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
      <div
        className="h-full transition-all duration-500"
        style={{ width: `${Math.max(0, Math.min(100, score))}%`, background: color, boxShadow: `0 0 6px ${color}` }}
      />
    </div>
  );
}

/**
 * Compact ATM ±4 probability view focused on option BUYERS:
 * - For each strike show CE buy-probability AND PE buy-probability bars
 * - Highlight the recommended pick (matches tradePlan.pick.strike)
 * - Show key metrics that matter to a buyer: LTP, Δ, IV, OI, theta
 */
export function StrikeProbability({ data }: { data: IntelSnapshot | null }) {
  if (!data || !data.ladder?.length) {
    return (
      <Panel title="ATM ±4 Buy Probability" className="h-full">
        <div className="flex h-full items-center justify-center text-xs text-white/30">
          waiting for option chain…
        </div>
      </Panel>
    );
  }

  const ladder = data.ladder;
  const pickStrike = data.tradePlan?.pick?.strike;
  const pickSide = data.tradePlan?.pick?.side;
  const cePctMaster = data.verdict?.cePct ?? 50;
  const pePctMaster = data.verdict?.pePct ?? 50;

  return (
    <Panel
      title="ATM ±4 — Buy Probability per Strike"
      badge={
        <span className="font-mono text-[10px] text-white/40">
          ATM {data.options.atm} · {ladder.length} strikes
        </span>
      }
      className="h-full"
      scroll
    >
      <div className="space-y-1.5">
        {ladder.map((row) => {
          const ceHealth = row.ce.health?.score ?? 50;
          const peHealth = row.pe.health?.score ?? 50;
          // Per-strike probability blends master verdict with per-leg health
          const ceProb = Math.round(0.6 * cePctMaster + 0.4 * ceHealth);
          const peProb = Math.round(0.6 * pePctMaster + 0.4 * peHealth);
          const ceColor = HEALTH_COLORS[row.ce.health?.state || "unknown"];
          const peColor = HEALTH_COLORS[row.pe.health?.state || "unknown"];
          const isPick = row.strike === pickStrike;

          return (
            <div
              key={row.strike}
              className={cn(
                "grid grid-cols-12 items-center gap-2 rounded-md border bg-black/20 px-2 py-1.5 transition-colors",
                row.isAtm
                  ? "border-amber-500/40 bg-amber-500/5"
                  : isPick
                    ? "border-emerald-500/40 bg-emerald-500/5"
                    : "border-white/[0.05]",
              )}
            >
              {/* CE side */}
              <div className="col-span-5 flex items-center gap-2">
                <div className="flex w-12 flex-col items-end font-mono text-[11px]">
                  <span className="font-bold text-emerald-400">{fmt(row.ce.ltp, 2)}</span>
                  <span className="text-[9px] text-white/40">Δ {fmt(row.ce.delta, 2)}</span>
                </div>
                <div className="flex flex-1 flex-col gap-1">
                  <div className="flex justify-between text-[9px] uppercase tracking-wider text-white/40">
                    <span>CE buy prob</span>
                    <span style={{ color: ceColor }}>{ceProb}%</span>
                  </div>
                  <HealthBar score={ceProb} color={ceColor} />
                </div>
                {pickSide === "CE" && isPick ? (
                  <span className="rounded bg-emerald-500/30 px-1 py-0.5 text-[8px] font-bold text-emerald-200">
                    PICK
                  </span>
                ) : null}
              </div>

              {/* Strike */}
              <div className="col-span-2 text-center">
                <div
                  className={cn(
                    "font-mono text-sm font-bold",
                    row.isAtm ? "text-amber-400" : "text-white/85",
                  )}
                >
                  {row.strike}
                </div>
                <div className="text-[9px] text-white/35">
                  {row.isAtm ? "ATM" : row.strike > data.options.atm ? "OTM CE / ITM PE" : "ITM CE / OTM PE"}
                </div>
              </div>

              {/* PE side */}
              <div className="col-span-5 flex items-center gap-2">
                {pickSide === "PE" && isPick ? (
                  <span className="rounded bg-rose-500/30 px-1 py-0.5 text-[8px] font-bold text-rose-200">
                    PICK
                  </span>
                ) : null}
                <div className="flex flex-1 flex-col gap-1">
                  <div className="flex justify-between text-[9px] uppercase tracking-wider text-white/40">
                    <span style={{ color: peColor }}>{peProb}%</span>
                    <span>PE buy prob</span>
                  </div>
                  <HealthBar score={peProb} color={peColor} />
                </div>
                <div className="flex w-12 flex-col items-start font-mono text-[11px]">
                  <span className="font-bold text-rose-400">{fmt(row.pe.ltp, 2)}</span>
                  <span className="text-[9px] text-white/40">Δ {fmt(row.pe.delta, 2)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 rounded border border-white/[0.06] bg-black/30 p-2 text-[10px] text-white/55">
        Probability = 60% master verdict + 40% per-strike premium health.
        Health considers delta band, IV, theta drag, OI build/unwind, bias alignment, liquidity.
      </div>
    </Panel>
  );
}
