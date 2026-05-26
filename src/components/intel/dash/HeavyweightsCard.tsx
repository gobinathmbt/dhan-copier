import type { IntelSnapshot } from "@/lib/intelTypes";
import { Card, fmtSigned } from "./common";

export function HeavyweightsCard({ data }: { data: IntelSnapshot | null }) {
  if (!data) return <Card title="Heavyweights Contribution">…</Card>;
  const rows = data.dashboard?.heavyweightsImpact || [];
  const total = data.dashboard?.heavyweightsTotalImpact ?? 0;

  return (
    <Card title="Heavyweights Contribution">
      <div className="flex h-full flex-col">
        <div className="grid grid-cols-12 gap-2 border-b border-white/[0.06] pb-1 text-[8px] uppercase tracking-wider text-white/40">
          <div className="col-span-3">Symbol</div>
          <div className="col-span-3 text-right">Last</div>
          <div className="col-span-3 text-right">Chg%</div>
          <div className="col-span-3 text-right">Impact</div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {rows.map((r) => {
            const c = r.changePct;
            const positive = c >= 0;
            return (
              <div
                key={r.symbol}
                className="grid grid-cols-12 items-center gap-2 border-b border-white/[0.03] py-1 text-[11px] last:border-b-0"
              >
                <div className="col-span-3 truncate text-white/85">{r.symbol}</div>
                <div className="col-span-3 text-right font-mono text-white/80">{r.last.toFixed(2)}</div>
                <div className={`col-span-3 text-right font-mono ${positive ? "text-emerald-400" : "text-rose-400"}`}>
                  {positive ? "+" : ""}
                  {c.toFixed(2)}%
                </div>
                <div className={`col-span-3 text-right font-mono ${r.impactPts >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                  {fmtSigned(r.impactPts, 2)}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-1 flex items-center justify-between border-t border-white/[0.06] pt-1.5 text-[10px]">
          <span className="text-white/45">Total Index Impact</span>
          <span className={`font-mono text-sm font-bold ${total >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
            {fmtSigned(total, 2)}
          </span>
        </div>
      </div>
    </Card>
  );
}
