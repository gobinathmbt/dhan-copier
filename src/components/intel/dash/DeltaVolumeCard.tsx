import type { IntelSnapshot } from "@/lib/intelTypes";
import { Card, fmtCompact, fmtSigned, fmt } from "./common";
import { LineChart, Line, ResponsiveContainer, YAxis, XAxis, ReferenceLine, Tooltip } from "recharts";

export function DeltaVolumeCard({ data }: { data: IntelSnapshot | null }) {
  if (!data) return <Card title="Delta & Volume">…</Card>;
  const d = data.dashboard?.delta;
  const cvd = data.dashboard?.cvdSeries || [];
  const totalBuy = d?.totalBuyVol ?? 0;
  const totalSell = d?.totalSellVol ?? 0;
  const total = totalBuy + totalSell;
  const buyPct = total ? Math.round((totalBuy / total) * 100) : 50;
  const sellPct = 100 - buyPct;
  const netDelta = d?.netDelta ?? 0;
  const positive = netDelta >= 0;

  return (
    <Card title="Delta & Volume">
      <div className="grid h-full grid-cols-12 grid-rows-[auto_1fr_auto] gap-2 overflow-hidden">
        <div className="col-span-12 grid grid-cols-3 gap-2 text-[10px]">
          <div>
            <div className="text-white/35">Total Buy Vol</div>
            <div className="font-mono text-sm font-bold text-emerald-400">
              {fmtCompact(totalBuy)}
            </div>
          </div>
          <div>
            <div className="text-white/35">Total Sell Vol</div>
            <div className="font-mono text-sm font-bold text-rose-400">
              {fmtCompact(totalSell)}
            </div>
          </div>
          <div>
            <div className="text-white/35">Delta</div>
            <div className={`font-mono text-sm font-bold ${positive ? "text-emerald-400" : "text-rose-400"}`}>
              {netDelta >= 0 ? "+" : ""}{fmtCompact(netDelta)}
            </div>
            <div className={`text-[9px] ${positive ? "text-emerald-400" : "text-rose-400"}`}>
              {positive ? "POSITIVE" : "NEGATIVE"}
            </div>
          </div>
        </div>

        {/* Cumulative delta chart */}
        <div className="col-span-12 mt-1 flex-1" style={{ minHeight: 100 }}>
          <div className="mb-0.5 flex items-center justify-between text-[9px] text-white/40">
            <span>Cumulative Delta</span>
            <span className={positive ? "text-emerald-400" : "text-rose-400"}>
              {fmtSigned(d?.deltaPct ?? 0, 2)}%
            </span>
          </div>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={cvd.length ? cvd : _flatLine()} margin={{ top: 4, right: 6, left: 0, bottom: 16 }}>
              <XAxis dataKey="t" stroke="rgba(255,255,255,0.3)" tick={{ fontSize: 8 }} tickLine={false} axisLine={false}
                tickFormatter={(t) => new Date(Number(t) * 1000).toTimeString().slice(0, 5)} />
              <YAxis hide />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" />
              <Tooltip
                contentStyle={{ background: "#0a0d12", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, fontSize: 10 }}
                formatter={(v: number) => [fmt(v, 0), "CVD"]}
                labelFormatter={(t: number) => new Date(Number(t) * 1000).toLocaleTimeString()}
              />
              <Line type="monotone" dataKey="cvd" stroke={positive ? "#22c55e" : "#ef4444"} strokeWidth={1.5} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Bid/Ask Imbalance bar */}
        <div className="col-span-12 mt-1">
          <div className="mb-0.5 flex items-center justify-between text-[9px] text-white/40">
            <span>Bid / Ask Imbalance</span>
          </div>
          <div className="relative h-3 w-full overflow-hidden rounded bg-white/[0.05]">
            <div
              className="absolute inset-y-0 left-0 flex items-center justify-center bg-emerald-500/40 text-[9px] font-bold text-emerald-200"
              style={{ width: `${buyPct}%` }}
            >
              {buyPct}%
            </div>
            <div
              className="absolute inset-y-0 right-0 flex items-center justify-center bg-rose-500/40 text-[9px] font-bold text-rose-200"
              style={{ width: `${sellPct}%` }}
            >
              {sellPct}%
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

function _flatLine() {
  // Synthesize a flat-zero baseline when no CVD data
  const now = Math.floor(Date.now() / 1000);
  return Array.from({ length: 12 }).map((_, i) => ({ t: now - (12 - i) * 600, cvd: 0 }));
}
