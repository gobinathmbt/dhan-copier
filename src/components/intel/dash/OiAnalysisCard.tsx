import type { IntelSnapshot } from "@/lib/intelTypes";
import { Card, fmtCompact, fmtSignedCompact } from "./common";
import { BarChart, Bar, ResponsiveContainer, XAxis, YAxis, ReferenceLine, Tooltip } from "recharts";

export function OiAnalysisCard({ data }: { data: IntelSnapshot | null }) {
  if (!data) return <Card title="OI Analysis">…</Card>;
  const oi = data.flow?.oi;
  const histogram = data.dashboard?.oiHistogram || [];
  const pcr = oi?.pcr ?? 0;
  const pcrTone = pcr >= 1.1 ? "text-emerald-400" : pcr <= 0.85 ? "text-rose-400" : "text-white/85";
  const pcrLabel = pcr >= 1.1 ? "BULLISH" : pcr <= 0.85 ? "BEARISH" : "NEUTRAL";

  return (
    <Card
      title="OI Analysis"
      right={<span className="font-mono text-[10px] text-white/40">PCR {pcr.toFixed(3)}</span>}
    >
      <div className="grid h-full grid-cols-12 grid-rows-[auto_1fr_auto] gap-2 overflow-hidden">
        {/* Left: stats */}
        <div className="col-span-12 grid grid-cols-3 gap-2 text-[10px]">
          <div>
            <div className="text-white/35">CE OI</div>
            <div className="font-mono text-sm font-bold text-emerald-400">
              {fmtCompact(oi?.ceTotal)}
            </div>
          </div>
          <div>
            <div className="text-white/35">PE OI</div>
            <div className="font-mono text-sm font-bold text-rose-400">
              {fmtCompact(oi?.peTotal)}
            </div>
          </div>
          <div>
            <div className="text-white/35">PCR</div>
            <div className={`font-mono text-sm font-bold ${pcrTone}`}>{pcr.toFixed(3)}</div>
            <div className="text-[9px] text-white/45">{pcrLabel}</div>
          </div>
        </div>

        {/* Histogram */}
        <div className="col-span-12 mt-1 flex-1" style={{ height: 120 }}>
          <div className="mb-0.5 flex items-center justify-between text-[9px] text-white/40">
            <span>OI Change (vs Prev Day)</span>
            <span>
              <span className="text-emerald-400">CE +{fmtSignedCompact(_sumPos(histogram.map((h) => h.ceOiChg)))}</span>
              <span className="ml-2 text-rose-400">PE {fmtSignedCompact(_sumPos(histogram.map((h) => h.peOiChg)))}</span>
            </span>
          </div>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={histogram} margin={{ top: 4, right: 0, left: 0, bottom: 16 }} barCategoryGap={2}>
              <XAxis
                dataKey="strike"
                stroke="rgba(255,255,255,0.3)"
                tick={{ fontSize: 8 }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis hide />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.1)" />
              <Tooltip
                contentStyle={{
                  background: "#0a0d12",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 4,
                  fontSize: 10,
                }}
                formatter={(v: number, name: string) => [fmtSignedCompact(v), name === "ceOiChg" ? "CE ΔOI" : "PE ΔOI"]}
              />
              <Bar dataKey="ceOiChg" fill="#10b981" />
              <Bar dataKey="peOiChg" fill="#ef4444" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Max pain row */}
        <div className="col-span-12 -mt-1 flex items-center justify-between border-t border-white/[0.04] pt-1.5 text-[10px]">
          <span className="text-white/40">Max Pain:</span>
          <span className="font-mono text-sm font-bold text-amber-400">{data.options.maxPain ?? "—"}</span>
        </div>
      </div>
    </Card>
  );
}

function _sumPos(arr: number[]): number {
  return arr.reduce((a, b) => a + (b > 0 ? b : 0), 0);
}
