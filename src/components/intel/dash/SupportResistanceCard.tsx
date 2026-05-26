import type { IntelSnapshot } from "@/lib/intelTypes";
import { Card, fmtSigned } from "./common";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

function fmtOiCompact(c: { val: number; unit: string } | undefined): string {
  if (!c) return "—";
  return `${c.val}${c.unit}`;
}

export function SupportResistanceCard({ data }: { data: IntelSnapshot | null }) {
  if (!data) return <Card title="Support / Resistance">…</Card>;
  const sr = data.dashboard?.supportResistance;
  if (!sr) return <Card title="Support / Resistance">…</Card>;

  const tilt = sr.pressureScore; // 0..100, higher = more support pressure (bullish)
  // For the arrow, positive = right (bullish/support side green); we want
  // the arrow to drift toward where the market is being PUSHED. Support
  // pressure pushes UP/RIGHT into resistance — so a high score (100) means
  // strong supports → market wants to go up → arrow toward right.
  const arrowPct = tilt; // simple mapping

  const bullish = sr.verdict === "BULLISH";
  const bearish = sr.verdict === "BEARISH";
  const verdictTone = bullish ? "#10b981" : bearish ? "#ef4444" : "#9ca3af";
  const verdictLabel = bullish
    ? "MARKET MOVING UP"
    : bearish
      ? "MARKET MOVING DOWN"
      : "BALANCED";

  return (
    <Card
      title="Support / Resistance Pressure"
      right={
        <span className="font-mono text-[10px] text-white/40">
          ATM {sr.atmStrike}
        </span>
      }
    >
      <div className="flex h-full flex-col gap-3 overflow-hidden">
        {/* Verdict badge */}
        <div className="flex items-center justify-center">
          <div
            className="flex items-center gap-2 rounded-md border px-3 py-1.5"
            style={{
              borderColor: `${verdictTone}80`,
              background: `${verdictTone}12`,
              color: verdictTone,
            }}
          >
            {bullish ? <TrendingUp size={14} /> : bearish ? <TrendingDown size={14} /> : <Minus size={14} />}
            <span className="text-xs font-bold uppercase tracking-[0.18em]">
              {verdictLabel}
            </span>
          </div>
        </div>

        {/* The pressure bar — green left (PE / support), red right (CE / resistance) */}
        <div>
          <div className="mb-1.5 flex items-center justify-between text-[9px] uppercase tracking-[0.14em]">
            <span className="flex items-center gap-1 text-emerald-400">
              <TrendingUp size={9} />
              Support · PE Walls
            </span>
            <span className="flex items-center gap-1 text-rose-400">
              Resistance · CE Walls
              <TrendingDown size={9} />
            </span>
          </div>

          {/* The bar */}
          <div className="relative h-6 overflow-visible rounded-md border border-white/[0.08] bg-black/40">
            {/* Left half — emerald (support side) */}
            <div
              className="absolute inset-y-0 left-0 flex items-center justify-start px-2 transition-all duration-700"
              style={{
                width: `${tilt}%`,
                background:
                  "linear-gradient(90deg, rgba(16,185,129,0.45) 0%, rgba(16,185,129,0.15) 100%)",
              }}
            >
              <span className="text-[10px] font-bold tabular-nums text-emerald-200">
                {tilt}%
              </span>
            </div>
            {/* Right half — rose (resistance side) */}
            <div
              className="absolute inset-y-0 right-0 flex items-center justify-end px-2 transition-all duration-700"
              style={{
                width: `${100 - tilt}%`,
                background:
                  "linear-gradient(90deg, rgba(239,68,68,0.15) 0%, rgba(239,68,68,0.45) 100%)",
              }}
            >
              <span className="text-[10px] font-bold tabular-nums text-rose-200">
                {100 - tilt}%
              </span>
            </div>
            {/* Center divider */}
            <div className="absolute top-0 h-full w-px bg-white/30" style={{ left: "50%" }} />

            {/* Arrow marker */}
            <div
              className="absolute -top-2 transition-all duration-700 ease-out"
              style={{ left: `${arrowPct}%`, transform: "translateX(-50%)" }}
            >
              <div
                className="flex flex-col items-center"
                style={{ filter: `drop-shadow(0 0 6px ${verdictTone})` }}
              >
                <div
                  className="h-0 w-0"
                  style={{
                    borderLeft: "5px solid transparent",
                    borderRight: "5px solid transparent",
                    borderTop: `6px solid ${verdictTone}`,
                  }}
                />
                <div
                  className="-mt-px h-7 w-[2px]"
                  style={{ background: verdictTone }}
                />
              </div>
            </div>
          </div>

          {/* Strength numbers under the bar */}
          <div className="mt-1 flex items-center justify-between text-[9px] text-white/40">
            <span>Strength {sr.supportStrength.toLocaleString()}</span>
            <span className="text-white/55">
              spot {sr.spotPrice.toFixed(2)}
            </span>
            <span>Strength {sr.resistanceStrength.toLocaleString()}</span>
          </div>
        </div>

        {/* Supports + Resistances side-by-side */}
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-hidden">
          <WallList
            title="Top Supports (PE)"
            tone="bull"
            rows={sr.supports}
            current={sr.spotPrice}
          />
          <WallList
            title="Top Resistances (CE)"
            tone="bear"
            rows={sr.resistances}
            current={sr.spotPrice}
          />
        </div>
      </div>
    </Card>
  );
}

function WallList({
  title,
  tone,
  rows,
  current,
}: {
  title: string;
  tone: "bull" | "bear";
  rows: NonNullable<IntelSnapshot["dashboard"]>["supportResistance"]["supports"];
  current: number;
}) {
  const titleColor = tone === "bull" ? "text-emerald-400" : "text-rose-400";
  const valColor = tone === "bull" ? "text-emerald-300" : "text-rose-300";
  return (
    <div className="flex min-h-0 flex-col gap-1">
      <div className={cn("text-center text-[9px] font-bold uppercase tracking-[0.14em]", titleColor)}>
        {title}
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {rows.length ? (
          rows.map((r) => {
            const dist = r.distance;
            const oiChg = r.oiChange;
            const oiChgPositive = oiChg > 0;
            return (
              <div
                key={r.strike}
                className={cn(
                  "rounded border bg-black/30 px-2 py-1.5",
                  tone === "bull" ? "border-emerald-500/20" : "border-rose-500/20",
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm font-bold text-white">{r.strike}</span>
                  <span className="text-[9px] text-white/40">{dist >= 0 ? "+" : ""}{dist} pt</span>
                </div>
                <div className="mt-0.5 flex items-center justify-between text-[10px]">
                  <span className="text-white/45">OI</span>
                  <span className={cn("font-mono font-bold", valColor)}>
                    {fmtOiCompact(r.oiCompact)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-white/45">ΔOI</span>
                  <span
                    className={cn(
                      "font-mono",
                      oiChgPositive ? "text-emerald-400" : oiChg < 0 ? "text-rose-400" : "text-white/55",
                    )}
                  >
                    {oiChg > 0 ? "+" : ""}{fmtOiCompact(r.oiChangeCompact)}
                  </span>
                </div>
                {/* Mini intent tag — strengthening / unwinding */}
                <div className="mt-0.5 text-[9px] text-white/45">
                  {Math.abs(oiChg) > r.oi * 0.1
                    ? oiChgPositive
                      ? tone === "bull" ? "PE writers ADDING — support firming" : "CE writers ADDING — resistance firming"
                      : tone === "bull" ? "PE UNWINDING — support weakening" : "CE UNWINDING — resistance weakening"
                    : "stable"}
                </div>
              </div>
            );
          })
        ) : (
          <div className="flex h-full items-center justify-center text-[10px] text-white/25">
            none nearby
          </div>
        )}
      </div>
    </div>
  );
}
