import type { IntelSnapshot } from "@/lib/intelTypes";
import { Card, fmt, fmtCompact, YesNoDot, Pill } from "./common";
import { LineChart, Line, ResponsiveContainer, YAxis, XAxis, Tooltip } from "recharts";

export function SpotFutCard({ data }: { data: IntelSnapshot | null }) {
  if (!data) return <Card title="Spot vs Futures">…</Card>;
  const series = data.dashboard?.spotFutSeries;
  const fut = data.dashboard?.futuresInfo;
  const buildUp = data.dashboard?.buildUp;

  // Merge spot + futures series by time index (use min length)
  const len = Math.min(series?.spot.length ?? 0, series?.futures.length ?? 0);
  const merged = Array.from({ length: len }).map((_, i) => ({
    t: series!.spot[i].t,
    spot: series!.spot[i].v,
    fut: series!.futures[i].v,
  }));
  // If futures missing, fall back to spot only
  const chartData = merged.length ? merged : (series?.spot || []).map((p) => ({ t: p.t, spot: p.v, fut: null }));

  return (
    <Card
      title="Spot vs Futures"
      right={<span className="font-mono text-[10px] text-white/40">{chartData.length} pts</span>}
    >
      <div className="grid h-full grid-cols-12 gap-2 overflow-hidden">
        <div className="col-span-7 flex min-h-0 flex-col">
          <div className="grid grid-cols-3 gap-2 text-[10px]">
            <div>
              <div className="text-white/35">Spot</div>
              <div className="font-mono text-sm font-bold text-white">{fmt(data.spot.ltp)}</div>
            </div>
            <div>
              <div className="text-white/35">Futures</div>
              <div className="font-mono text-sm font-bold text-sky-300">{fmt(data.futures.ltp)}</div>
            </div>
            <div>
              <div className="text-white/35">Premium</div>
              <div className={data.futures.basis >= 0 ? "font-mono text-sm font-bold text-emerald-400" : "font-mono text-sm font-bold text-rose-400"}>
                {data.futures.basis >= 0 ? "+" : ""}
                {fmt(data.futures.basis)}
              </div>
              <div className="text-[9px] text-white/45">
                {data.spot.priorClose ? `${((data.futures.basis / data.spot.priorClose) * 100).toFixed(2)}%` : ""}
              </div>
            </div>
          </div>
          <div className="mt-1 flex-1">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 4, right: 6, left: 0, bottom: 0 }}>
                <XAxis dataKey="t" hide />
                <YAxis
                  hide
                  domain={[(dataMin: number) => dataMin * 0.999, (dataMax: number) => dataMax * 1.001]}
                />
                <Tooltip
                  contentStyle={{ background: "#0a0d12", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, fontSize: 10 }}
                  formatter={(v: number) => fmt(v, 2)}
                  labelFormatter={(t: number) => new Date(t * 1000).toLocaleTimeString()}
                />
                <Line type="monotone" dataKey="spot" stroke="#22c55e" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="fut" stroke="#3b82f6" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="col-span-5 space-y-1.5 text-[10px]">
          <Row
            label="Basis Trend"
            value={
              <Pill
                label={fut?.basisTrend?.toUpperCase() ?? "—"}
                tone={fut?.basisTrend === "expanding" ? "bull" : fut?.basisTrend === "contracting" ? "bear" : "neutral"}
                size="xs"
              />
            }
          />
          <Row label="Fut OI" value={<span className="font-mono">{fmtCompact(fut?.oi)}</span>} />
          <Row
            label="Fut OI Change"
            value={
              <span className={`font-mono ${(fut?.oiChange ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {(fut?.oiChange ?? 0) >= 0 ? "+" : ""}
                {fmtCompact(fut?.oiChange)}
              </span>
            }
          />
          <Row label="Fut Volume" value={<span className="font-mono">{fmtCompact(fut?.volume)}</span>} />
          <Row label="Long Build-up" value={<YesNoDot yes={!!buildUp?.longBuildUp} />} />
          <Row label="Short Covering" value={<YesNoDot yes={!!buildUp?.shortCovering} />} />
        </div>
      </div>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-white/[0.04] py-1 last:border-b-0">
      <span className="text-white/45">{label}</span>
      {value}
    </div>
  );
}
