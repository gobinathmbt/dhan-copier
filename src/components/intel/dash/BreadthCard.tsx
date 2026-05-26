import type { IntelSnapshot } from "@/lib/intelTypes";
import { Card } from "./common";
import { cn } from "@/lib/utils";

export function BreadthCard({ data }: { data: IntelSnapshot | null }) {
  if (!data) return <Card title="Market Breadth">…</Card>;
  const b = data.dashboard?.breadth;
  if (!b) return <Card title="Market Breadth">…</Card>;
  const advPct = b.advancePct;
  const total = b.total ?? (b.advancing + b.declining + b.unchanged);
  const sampled = b.sampled ?? total;
  const symbolLabel = data.symbol === "SENSEX" ? "SENSEX 30" : "NIFTY 50";

  // Donut: advance ring vs decline ring on the same circle
  const radius = 26;
  const cx = 32;
  const cy = 32;
  const circumference = 2 * Math.PI * radius;
  const advLen = (advPct / 100) * circumference;

  return (
    <Card
      title="Market Breadth"
      right={
        <span className="font-mono text-[10px] text-white/40">
          {symbolLabel} · {sampled}/{total}
        </span>
      }
    >
      <div className="flex h-full items-center gap-2 overflow-hidden">
        {/* Donut */}
        <div className="shrink-0">
          <svg width="64" height="64" viewBox="0 0 64 64">
            <circle
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke="rgba(239,68,68,0.25)"
              strokeWidth="6"
            />
            <circle
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke="#22c55e"
              strokeWidth="6"
              strokeDasharray={`${advLen} ${circumference}`}
              transform={`rotate(-90 ${cx} ${cy})`}
              style={{ filter: "drop-shadow(0 0 3px #22c55e)" }}
            />
            <text x={cx} y={cy - 1} textAnchor="middle" fill="#22c55e" style={{ font: "bold 13px monospace" }}>
              {advPct}%
            </text>
            <text x={cx} y={cy + 9} textAnchor="middle" fill="rgba(255,255,255,0.4)" style={{ font: "7px monospace" }}>
              ADV
            </text>
          </svg>
        </div>

        {/* Counts column */}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-[11px]">
          <Row label="Advancing" value={b.advancing} tone="text-emerald-400" />
          <Row label="Declining" value={b.declining} tone="text-rose-400" />
          <Row label="Unchanged" value={b.unchanged} tone="text-white/60" />
          <div className="mt-0.5 flex items-center justify-between border-t border-white/[0.06] pt-1">
            <span className="text-[10px] text-white/45">A/D Ratio</span>
            <span className={cn("font-mono text-sm font-bold", b.adRatio >= 1 ? "text-emerald-400" : "text-rose-400")}>
              {b.adRatio}
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
}

function Row({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[10px] text-white/45">{label}</span>
      <span className={`font-mono text-sm font-bold ${tone}`}>{value}</span>
    </div>
  );
}
