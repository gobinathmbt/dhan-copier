import type { IntelSnapshot } from "@/lib/intelTypes";
import { Panel } from "./Panel";

const FACTOR_LABELS: Record<string, string> = {
  derivatives: "OI / PCR / Max-pain",
  futures: "Futures Leadership",
  delta: "Delta / CVD",
  vwap: "VWAP Position",
  ema: "EMA Stack",
  cpr: "CPR Position",
  heavyweights: "NIFTY Heavyweights",
  vix: "India VIX",
  gift: "GIFT NIFTY",
  fiiDii: "FII / DII Cash",
  volumeAccept: "Volume / FRVP",
  microstructure: "Microstructure",
  oiWriters: "OI Writers (PE/CE)",
  trap: "Trap Detector",
  gamma: "Gamma Regime",
};

function FactorBar({
  label,
  value,
  weight,
}: {
  label: string;
  value: number;
  weight: number;
}) {
  // value is roughly -100..+100; positive = bullish for CE
  const v = Math.max(-100, Math.min(100, Number(value || 0)));
  const positive = v >= 0;
  const color = v > 5 ? "#10b981" : v < -5 ? "#ef4444" : "#6b7280";
  const widthPct = Math.abs(v) / 2; // 0..50% of half bar

  return (
    <div className="grid grid-cols-12 items-center gap-2 py-1 text-[11px]">
      <div className="col-span-4 truncate text-white/60" title={label}>
        {label}
      </div>
      <div className="col-span-7 relative h-2 rounded-full bg-white/[0.05]">
        <div
          className="absolute top-0 h-full bg-white/15"
          style={{ left: "50%", width: 1 }}
        />
        <div
          className="absolute top-0 h-full transition-all duration-500"
          style={{
            left: positive ? "50%" : `${50 - widthPct}%`,
            width: `${widthPct}%`,
            background: color,
            boxShadow: `0 0 6px ${color}`,
          }}
        />
      </div>
      <div className="col-span-1 text-right text-[9px] text-white/40">
        {Math.round(weight * 100)}%
      </div>
    </div>
  );
}

export function FactorBreakdown({ data }: { data: IntelSnapshot | null }) {
  if (!data?.verdict) {
    return (
      <Panel title="Factor Breakdown" className="h-full">
        <div className="flex h-full items-center justify-center text-xs text-white/30">
          loading…
        </div>
      </Panel>
    );
  }
  const v = data.verdict;
  const factorEntries = Object.entries(v.factors)
    .map(([k, val]) => ({
      key: k,
      label: FACTOR_LABELS[k] || k,
      value: Number(val) || 0,
      weight: v.weights[k] || 0,
    }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  return (
    <Panel
      title="Factor Breakdown"
      badge={<span className="text-[10px] text-white/40">15 weighted inputs · sorted by magnitude</span>}
      className="h-full"
      scroll
    >
      <div className="mb-2 flex items-center justify-between text-[9px] uppercase tracking-wider text-white/40">
        <span className="text-rose-400">PE bias ←</span>
        <span className="text-white/35">neutral</span>
        <span className="text-emerald-400">→ CE bias</span>
      </div>
      <div>
        {factorEntries.map((f) => (
          <FactorBar key={f.key} label={f.label} value={f.value} weight={f.weight} />
        ))}
      </div>
      <div className="mt-3 rounded border border-white/[0.06] bg-black/30 p-2 text-[10px] text-white/55">
        <div className="font-semibold uppercase tracking-wider text-white/45">Logic</div>
        Positive value = bullish (favours CE buy). Negative = bearish (favours PE buy).
        Weight column shows each factor's contribution to the final 0-100 master probability.
      </div>
    </Panel>
  );
}
