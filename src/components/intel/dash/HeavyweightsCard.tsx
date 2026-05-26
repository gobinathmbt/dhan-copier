import type { IntelSnapshot } from "@/lib/intelTypes";
import { Card, fmtSigned } from "./common";
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";

/**
 * Heavyweights Pie — visual breakdown of how many of the index's top
 * weight stocks are advancing vs declining vs unchanged.
 * Shows 3 leaders + 3 laggards as small chips at the bottom.
 */
export function HeavyweightsCard({ data }: { data: IntelSnapshot | null }) {
  if (!data) return <Card title="Heavyweights">…</Card>;
  const h = data.heavyweights;
  if (!h) return <Card title="Heavyweights">…</Card>;

  const adv = h.advancing ?? 0;
  const dec = h.declining ?? 0;
  const unc = h.unchanged ?? 0;
  const total = h.total ?? (adv + dec + unc);

  const pieData = [
    { name: "Advancing", value: adv, color: "#10b981" },
    { name: "Declining", value: dec, color: "#ef4444" },
    { name: "Unchanged", value: unc, color: "#6b7280" },
  ].filter((d) => d.value > 0);

  const totalImpact = h.weightedAvgChangePct ?? 0;
  const impactColor = totalImpact >= 0 ? "#10b981" : "#ef4444";
  const symbolLabel = h.symbol === "SENSEX" ? "SENSEX 30" : h.symbol === "BANKNIFTY" ? "BANK NIFTY" : "NIFTY 50";

  return (
    <Card
      title="Heavyweights"
      right={<span className="font-mono text-[10px] text-white/40">{symbolLabel} top {total}</span>}
    >
      <div className="flex h-full items-center gap-3">
        {/* Pie chart with center label */}
        <div className="relative h-32 w-32 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={pieData.length ? pieData : [{ name: "—", value: 1, color: "#374151" }]}
                cx="50%"
                cy="50%"
                innerRadius={36}
                outerRadius={56}
                paddingAngle={2}
                stroke="none"
                dataKey="value"
                isAnimationActive={false}
              >
                {(pieData.length ? pieData : [{ color: "#374151" }]).map((d, i) => (
                  <Cell key={i} fill={d.color} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[8px] uppercase tracking-wider text-white/45">Net</span>
            <span className="font-mono text-base font-bold" style={{ color: impactColor }}>
              {fmtSigned(totalImpact, 2)}%
            </span>
          </div>
        </div>

        {/* Legend + leaders / laggards */}
        <div className="flex min-w-0 flex-1 flex-col gap-2 text-[11px]">
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Up" value={adv} color="#10b981" />
            <Stat label="Down" value={dec} color="#ef4444" />
            <Stat label="Flat" value={unc} color="#6b7280" />
          </div>

          {h.leaders?.length ? (
            <div>
              <div className="mb-0.5 text-[8px] uppercase tracking-wider text-emerald-400/70">Leaders</div>
              <div className="space-y-0.5">
                {h.leaders.slice(0, 3).map((l) => (
                  <div key={l.name} className="flex items-center justify-between text-[10px]">
                    <span className="truncate text-white/75">{l.name}</span>
                    <span className="font-mono font-bold text-emerald-400">
                      {fmtSigned(Number(l.changePct), 2)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {h.laggards?.length ? (
            <div>
              <div className="mb-0.5 text-[8px] uppercase tracking-wider text-rose-400/70">Laggards</div>
              <div className="space-y-0.5">
                {h.laggards.slice(0, 3).map((l) => (
                  <div key={l.name} className="flex items-center justify-between text-[10px]">
                    <span className="truncate text-white/75">{l.name}</span>
                    <span className="font-mono font-bold text-rose-400">
                      {fmtSigned(Number(l.changePct), 2)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div
      className="flex flex-col items-center rounded border bg-black/25 py-1"
      style={{ borderColor: `${color}30` }}
    >
      <span className="text-[8px] uppercase tracking-wider text-white/40">{label}</span>
      <span className="font-mono text-sm font-bold" style={{ color }}>
        {value}
      </span>
    </div>
  );
}
