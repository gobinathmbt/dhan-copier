import type { IntelSnapshot } from "@/lib/intelTypes";
import { Card, fmt, TONE, toneOf } from "./common";
import { LineChart, Line, ResponsiveContainer, YAxis, XAxis, Tooltip } from "recharts";

export function IvCard({ data }: { data: IntelSnapshot | null }) {
  if (!data) return <Card title="IV / VIX Analytics">…</Card>;
  const v = data.dashboard?.ivAnalytics;
  if (!v) return <Card title="IV / VIX Analytics">…</Card>;
  const tone = TONE[toneOf(v.ivRank.tone)];

  return (
    <Card title="IV / VIX Analytics">
      <div className="flex h-full flex-col gap-2">
        <div className="grid grid-cols-3 gap-2 text-[10px]">
          <div>
            <div className="text-white/35">India VIX</div>
            <div className="font-mono text-sm font-bold text-white">{fmt(v.vix, 2)}</div>
            <div className={`text-[9px] ${(v.vixChangePct ?? 0) >= 0 ? "text-rose-400" : "text-emerald-400"}`}>
              {v.vixChangePct != null ? `${v.vixChangePct >= 0 ? "+" : ""}${v.vixChangePct.toFixed(2)}%` : "—"}
            </div>
          </div>
          <div>
            <div className="text-white/35">ATM IV</div>
            <div className="font-mono text-sm font-bold text-white">{fmt(v.atmIv, 2)}</div>
            <div className="text-[9px] text-white/45">
              {v.atmIvChangePct != null ? `${v.atmIvChangePct >= 0 ? "+" : ""}${v.atmIvChangePct.toFixed(2)}%` : "—"}
            </div>
          </div>
          <div>
            <div className="text-white/35">IV Rank</div>
            <div className="font-mono text-sm font-bold" style={{ color: tone.color }}>
              {v.ivRank.score}
            </div>
            <div className="text-[9px]" style={{ color: tone.color }}>
              {v.ivRank.label}
            </div>
          </div>
        </div>

        <div className="flex-1" style={{ minHeight: 80 }}>
          <div className="mb-0.5 text-[9px] text-white/40">IV Trend (ATM)</div>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={v.trend} margin={{ top: 4, right: 6, left: 0, bottom: 14 }}>
              <XAxis
                dataKey="t"
                stroke="rgba(255,255,255,0.3)"
                tick={{ fontSize: 8 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(t) => new Date(Number(t) * 1000).toTimeString().slice(0, 5)}
              />
              <YAxis hide domain={["auto", "auto"]} />
              <Tooltip
                contentStyle={{ background: "#0a0d12", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, fontSize: 10 }}
                formatter={(val: number) => fmt(val, 2)}
              />
              <Line type="monotone" dataKey="iv" stroke="#a855f7" strokeWidth={1.5} dot={{ fill: "#a855f7", r: 2 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </Card>
  );
}
