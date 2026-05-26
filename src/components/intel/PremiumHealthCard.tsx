import { TrendingUp, TrendingDown } from "lucide-react";
import type { IntelSnapshot, PremiumHealth } from "@/lib/intelTypes";
import { Panel, StatRow } from "./Panel";
import { premiumStateColor } from "./colors";

function fmt(n: number | null | undefined, d = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

function ScoreBar({ score, color }: { score: number; color: string }) {
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
      <div
        className="h-full transition-all duration-500"
        style={{ width: `${pct}%`, background: color, boxShadow: `0 0 6px ${color}` }}
      />
    </div>
  );
}

function HealthCard({
  side,
  health,
  atm,
  bias,
}: {
  side: "CE" | "PE";
  health: PremiumHealth;
  atm: { ltp: number; oi: number; iv: number; delta: number } | null;
  bias: string;
}) {
  const color = premiumStateColor(health.state);
  const isMatched = (side === "CE" && bias === "bullish") || (side === "PE" && bias === "bearish");

  return (
    <div
      className="flex flex-col gap-2 rounded-md border bg-black/20 p-2.5"
      style={{ borderColor: `${color}40` }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className="rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wider"
            style={{ background: `${color}25`, color }}
          >
            {side}
          </span>
          <span className="text-xs uppercase text-white/60">{health.state}</span>
          {isMatched ? (
            <span className="text-[9px] font-bold uppercase tracking-wider text-amber-400">
              · matched
            </span>
          ) : null}
        </div>
        <span className="font-mono text-base font-bold tabular-nums" style={{ color }}>
          {health.score}
        </span>
      </div>

      <ScoreBar score={health.score} color={color} />

      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 pt-1">
        <StatRow label="LTP" value={fmt(atm?.ltp ?? health.ltp)} tone="info" />
        <StatRow label="IV" value={fmt(atm?.iv, 1)} />
        <StatRow label="Δ" value={fmt(atm?.delta, 2)} />
        <StatRow label="OI" value={atm?.oi ? atm.oi.toLocaleString() : "—"} />
        <StatRow
          label="Velocity"
          value={`${fmt(Number(health.factors.velocity_ratio), 2)}×`}
          tone={Number(health.factors.velocity_ratio) >= 1.2 ? "bull" : "neutral"}
        />
        <StatRow
          label="|Δ|"
          value={fmt(Number(health.factors.delta_abs), 2)}
        />
      </div>
    </div>
  );
}

export function PremiumHealthPanel({ data }: { data: IntelSnapshot | null }) {
  if (!data) {
    return (
      <Panel title="Premium Health" className="h-full">
        <div className="flex h-full items-center justify-center text-xs text-white/30">
          waiting for data…
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="Premium Health"
      badge={
        <div className="flex items-center gap-1 text-[10px] text-white/45">
          <span className="font-mono">ATM {data.options.atm}</span>
          {data.bias.overallBias === "bullish" ? (
            <TrendingUp size={10} className="text-emerald-400" />
          ) : data.bias.overallBias === "bearish" ? (
            <TrendingDown size={10} className="text-rose-400" />
          ) : null}
        </div>
      }
      className="h-full"
    >
      <div className="flex flex-col gap-2">
        <HealthCard
          side="CE"
          health={data.premiumHealth.ce}
          atm={data.options.atmCall}
          bias={data.bias.overallBias}
        />
        <HealthCard
          side="PE"
          health={data.premiumHealth.pe}
          atm={data.options.atmPut}
          bias={data.bias.overallBias}
        />

        <div className="mt-1 rounded-md border border-white/[0.06] bg-black/20 p-2">
          <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-white/40">
            ATM IV / Greeks
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 pt-1">
            <StatRow label="ATM IV" value={fmt(data.options.atmIv, 1)} tone="info" />
            <StatRow label="Max Pain" value={fmt(data.options.maxPain, 0)} tone="warn" />
            <StatRow
              label="Call Wall"
              value={fmt(data.options.callWall, 0)}
              tone="bear"
              hint="Highest CE OI strike"
            />
            <StatRow
              label="Put Wall"
              value={fmt(data.options.putWall, 0)}
              tone="bull"
              hint="Highest PE OI strike"
            />
          </div>
        </div>
      </div>
    </Panel>
  );
}
