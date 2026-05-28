import type { IntelV2Snapshot } from "@/lib/intelV2Types";
import { V2Card } from "./common";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

function fmtOiCompact(c: { val: number; unit: string } | undefined): string {
  if (!c) return "—";
  return `${c.val}${c.unit}`;
}

export function SupportResistanceCardV2({ data }: { data: IntelV2Snapshot | null }) {
  if (!data) return <V2Card title="Support / Resistance Pressure">…</V2Card>;
  const sr = data.dashboard?.supportResistance;
  if (!sr) return <V2Card title="Support / Resistance Pressure">…</V2Card>;

  const tilt = sr.pressureScore ?? 50;
  const arrowPct = tilt;

  const bullish = sr.verdict === "BULLISH";
  const bearish = sr.verdict === "BEARISH";
  const verdictTone = bullish ? "#10b981" : bearish ? "#ef4444" : "#9ca3af";
  const verdictLabel = bullish
    ? "MARKET MOVING UP"
    : bearish
      ? "MARKET MOVING DOWN"
      : "BALANCED";

  const spotPrice = Number.isFinite(sr.spotPrice) ? sr.spotPrice : null;
  const supportStrength = Number.isFinite(sr.supportStrength) ? sr.supportStrength : 0;
  const resistanceStrength = Number.isFinite(sr.resistanceStrength) ? sr.resistanceStrength : 0;
  const atmStrike = sr.atmStrike ?? "—";
  const supports = sr.supports ?? [];
  const resistances = sr.resistances ?? [];

  return (
    <V2Card
      title="Support / Resistance Pressure"
      right={
        <span className="font-mono text-[12px] text-white/55">
          ATM {atmStrike}
        </span>
      }
    >
      <div className="flex h-full flex-col gap-3 overflow-hidden">
        {/* Verdict badge */}
        <div className="flex items-center justify-center">
          <div
            className="flex items-center gap-2 rounded-md border px-4 py-2"
            style={{
              borderColor: `${verdictTone}80`,
              background: `${verdictTone}12`,
              color: verdictTone,
            }}
          >
            {bullish ? <TrendingUp size={16} /> : bearish ? <TrendingDown size={16} /> : <Minus size={16} />}
            <span className="text-sm font-bold uppercase tracking-[0.18em]">
              {verdictLabel}
            </span>
          </div>
        </div>

        {/* Pressure bar â€” CE Walls (resistance) LEFT, PE Walls (support) RIGHT */}
        <div>
          <div className="mb-1.5 flex items-center justify-between text-[11px] uppercase tracking-[0.14em]">
            <span className="flex items-center gap-1 text-rose-400">
              <TrendingDown size={11} />
              Resistance Â· CE Walls
            </span>
            <span className="flex items-center gap-1 text-emerald-400">
              Support Â· PE Walls
              <TrendingUp size={11} />
            </span>
          </div>

          <div className="relative h-8 overflow-visible rounded-md border border-white/[0.08] bg-black/40">
            {/* LEFT half â€” CE / Resistance (red) */}
            <div
              className="absolute inset-y-0 left-0 flex items-center justify-start px-2 transition-all duration-700"
              style={{
                width: `${100 - tilt}%`,
                background:
                  "linear-gradient(90deg, rgba(239,68,68,0.45) 0%, rgba(239,68,68,0.15) 100%)",
              }}
            >
              <span className="text-[12px] font-bold tabular-nums text-rose-200">
                {100 - tilt}%
              </span>
            </div>
            {/* RIGHT half â€” PE / Support (green) */}
            <div
              className="absolute inset-y-0 right-0 flex items-center justify-end px-2 transition-all duration-700"
              style={{
                width: `${tilt}%`,
                background:
                  "linear-gradient(90deg, rgba(16,185,129,0.15) 0%, rgba(16,185,129,0.45) 100%)",
              }}
            >
              <span className="text-[12px] font-bold tabular-nums text-emerald-200">
                {tilt}%
              </span>
            </div>
            <div className="absolute top-0 h-full w-px bg-white/30" style={{ left: "50%" }} />
            {/* Needle â€” pulled to the side that dominates.
                tilt = support pct (0..100). When tilt=70 → bullish → needle should
                sit at 70% (toward right/PE side). */}
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
                    borderLeft: "6px solid transparent",
                    borderRight: "6px solid transparent",
                    borderTop: `7px solid ${verdictTone}`,
                  }}
                />
                <div
                  className="-mt-px h-9 w-[2px]"
                  style={{ background: verdictTone }}
                />
              </div>
            </div>
          </div>

          <div className="mt-1.5 flex items-center justify-between text-[11px] text-white/55">
            <span>Strength {resistanceStrength.toLocaleString()}</span>
            <span className="text-white/70">
              spot {spotPrice != null ? spotPrice.toFixed(2) : "â€”"}
            </span>
            <span>Strength {supportStrength.toLocaleString()}</span>
          </div>
        </div>

        {/* Walls side-by-side — CE (resistances) on the LEFT, PE (supports) on the RIGHT */}
        {/* <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-hidden">
          <WallList
            title="Top Resistances (CE)"
            tone="bear"
            rows={resistances}
          />
          <WallList
            title="Top Supports (PE)"
            tone="bull"
            rows={supports}
          />
        </div> */}

        {/* Bottom meter — which side dominates + percentage */}
        <SupportResistanceMeter
          supportStrength={supportStrength}
          resistanceStrength={resistanceStrength}
          tilt={tilt}
        />
      </div>
    </V2Card>
  );
}

function SupportResistanceMeter({
  supportStrength,
  resistanceStrength,
  tilt,
}: {
  supportStrength: number;
  resistanceStrength: number;
  tilt: number;
}) {
  // tilt 0..100 — higher = more support pressure (bullish)
  // CE (resistance) on left, PE (support) on right to mirror the wall layout above
  const cePct = Math.max(0, Math.min(100, 100 - tilt));   // resistance dominance
  const pePct = Math.max(0, Math.min(100, tilt));         // support dominance
  const dominantSide = cePct >= 60 ? "RESISTANCE FAVOURED (Buy PE)"
    : pePct >= 60 ? "SUPPORT FAVOURED (Buy CE)"
    : "BALANCED";
  const tone = cePct >= 60 ? "bear" : pePct >= 60 ? "bull" : "warn";
  const toneColor = tone === "bear" ? "#ef4444"
    : tone === "bull" ? "#10b981"
    : "#f59e0b";
  return (
    <div
      className="flex shrink-0 flex-col gap-1.5 rounded-md border px-3 py-2"
      style={{
        borderColor: `${toneColor}40`,
        background: `${toneColor}10`,
      }}
    >
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-bold uppercase tracking-wider" style={{ color: toneColor }}>
          {dominantSide}
        </span>
        <span className="font-mono font-bold tabular-nums" style={{ color: toneColor }}>
          {Math.max(cePct, pePct)}%
        </span>
      </div>
      {/* Two-segment bar — red CE on left, green PE on right */}
      <div className="flex h-2 overflow-hidden rounded-full bg-white/[0.06]">
        <div className="h-full bg-rose-500/80" style={{ width: `${cePct}%` }} />
        <div className="h-full bg-emerald-500/80" style={{ width: `${pePct}%` }} />
      </div>
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-rose-400">CE Wall {Math.round(cePct)}%</span>
        <span className="text-white/55 font-mono">
          R {resistanceStrength.toLocaleString()} | S {supportStrength.toLocaleString()}
        </span>
        <span className="text-emerald-400">PE Wall {Math.round(pePct)}%</span>
      </div>
    </div>
  );
}

function WallList({
  title,
  tone,
  rows,
}: {
  title: string;
  tone: "bull" | "bear";
  rows: NonNullable<IntelV2Snapshot["dashboard"]>["supportResistance"]["supports"];
}) {
  const titleColor = tone === "bull" ? "text-emerald-400" : "text-rose-400";
  const valColor = tone === "bull" ? "text-emerald-300" : "text-rose-300";
  return (
    <div className="flex min-h-0 flex-col gap-1">
      <div className={cn("text-center text-[11px] font-bold uppercase tracking-[0.16em]", titleColor)}>
        {title}
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
        {rows.length ? (
          rows.map((r) => {
            const dist = r.distance;
            const oiChg = r.oiChange;
            const oiChgPositive = oiChg > 0;
            return (
              <div
                key={r.strike}
                className={cn(
                  "rounded border bg-black/30 px-2.5 py-2",
                  tone === "bull" ? "border-emerald-500/20" : "border-rose-500/20",
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-base font-bold text-white">{r.strike}</span>
                  <span className="text-[10px] text-white/55">{dist >= 0 ? "+" : ""}{dist} pt</span>
                </div>
                <div className="mt-0.5 flex items-center justify-between text-[12px]">
                  <span className="text-white/55">OI</span>
                  <span className={cn("font-mono font-bold", valColor)}>
                    {fmtOiCompact(r.oiCompact)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[12px]">
                  <span className="text-white/55">ΔOI</span>
                  <span
                    className={cn(
                      "font-mono",
                      oiChgPositive ? "text-emerald-400" : oiChg < 0 ? "text-rose-400" : "text-white/65",
                    )}
                  >
                    {oiChg > 0 ? "+" : ""}{fmtOiCompact(r.oiChangeCompact)}
                  </span>
                </div>
                <div className="mt-0.5 text-[10px] text-white/55">
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
          <div className="flex h-full items-center justify-center text-[11px] text-white/35">
            none nearby
          </div>
        )}
      </div>
    </div>
  );
}
