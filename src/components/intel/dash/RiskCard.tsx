import type { IntelSnapshot } from "@/lib/intelTypes";
import { Card, fmt } from "./common";
import { Minus, Plus } from "lucide-react";

export function RiskCard({ data }: { data: IntelSnapshot | null }) {
  if (!data) return <Card title="Risk Management">…</Card>;
  const r = data.dashboard?.riskManagement;
  const pick = data.tradePlan?.pick;

  if (!r || !pick) {
    return (
      <Card title="Risk Management">
        <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
          <span className="text-xs text-white/45">No active pick</span>
          <span className="text-[10px] text-white/30">Master verdict neutral or market closed</span>
        </div>
      </Card>
    );
  }

  return (
    <Card title="Risk Management">
      <div className="h-full space-y-1.5 overflow-y-auto text-[11px]">
        <Row label="Entry Price" value={`${fmt(r.entryPrice, 2)}`} valueRight={`${r.slPct >= 0 ? "+" : ""}${r.slPct}%`} valueTone="warn" />
        <Row label="Stop Loss" value={`${fmt(r.stopLoss, 2)}`} valueRight={`${r.slPct}%`} valueTone="bear" />
        <Row label="Target 1" value={`${fmt(r.target1, 2)}`} valueRight={`+${r.target1Pct}%`} valueTone="bull" />
        <Row label="Target 2" value={`${fmt(r.target2, 2)}`} valueRight={`+${r.target2Pct}%`} valueTone="bull" />
        <div className="flex items-center justify-between border-t border-white/[0.06] pt-1.5">
          <span className="text-white/45">Risk / Reward</span>
          <span className="font-mono text-sm font-bold text-emerald-400">1 : {r.rr.toFixed(2)} : {(r.rr * 1.6).toFixed(1)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-white/45">Max Loss (Per Lot)</span>
          <span className="font-mono text-sm font-bold text-rose-400">₹{r.maxLossPerLot.toLocaleString()}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-white/45">Position Size (Lots)</span>
          <div className="flex items-center gap-1 rounded border border-white/[0.08] px-1 py-0.5">
            <Minus size={10} className="cursor-pointer text-white/55 hover:text-white/85" />
            <span className="w-6 text-center font-mono font-bold text-white">{r.positionLots}</span>
            <Plus size={10} className="cursor-pointer text-white/55 hover:text-white/85" />
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-white/[0.06] pt-1.5">
          <span className="text-white/45">Max Loss (Total)</span>
          <span className="font-mono text-base font-bold text-rose-400">
            ₹{r.maxLossTotal.toLocaleString()}
          </span>
        </div>
      </div>
    </Card>
  );
}

function Row({
  label,
  value,
  valueRight,
  valueTone,
}: {
  label: string;
  value: string;
  valueRight?: string;
  valueTone: "bull" | "bear" | "warn";
}) {
  const map: Record<string, string> = {
    bull: "text-emerald-400",
    bear: "text-rose-400",
    warn: "text-amber-400",
  };
  return (
    <div className="flex items-center justify-between">
      <span className="text-white/45">{label}</span>
      <div className="flex items-center gap-3 text-right">
        <span className="font-mono text-white/85">{value}</span>
        {valueRight ? (
          <span className={`font-mono text-[11px] font-bold ${map[valueTone]}`}>
            {valueRight}
          </span>
        ) : null}
      </div>
    </div>
  );
}
