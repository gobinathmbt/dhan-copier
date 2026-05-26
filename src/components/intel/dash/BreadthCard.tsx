import type { IntelSnapshot } from "@/lib/intelTypes";
import { Card } from "./common";

export function BreadthCard({ data }: { data: IntelSnapshot | null }) {
  if (!data) return <Card title="Market Breadth">…</Card>;
  const b = data.dashboard?.breadth;
  if (!b) return <Card title="Market Breadth">…</Card>;
  const advPct = b.advancePct;

  // Donut: advance vs decline ring
  const radius = 32;
  const cx = 40;
  const cy = 40;
  const circumference = 2 * Math.PI * radius;
  const advLen = (advPct / 100) * circumference;

  return (
    <Card title="Market Breadth">
      <div className="flex h-full items-center gap-3">
        {/* Donut */}
        <div className="flex flex-col items-center">
          <svg width="80" height="80" viewBox="0 0 80 80">
            {/* Background ring */}
            <circle
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke="rgba(239,68,68,0.25)"
              strokeWidth="8"
            />
            {/* Advance arc */}
            <circle
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke="#22c55e"
              strokeWidth="8"
              strokeDasharray={`${advLen} ${circumference}`}
              transform={`rotate(-90 ${cx} ${cy})`}
              style={{ filter: "drop-shadow(0 0 4px #22c55e)" }}
            />
            <text x={cx} y={cy - 4} textAnchor="middle" fill="#22c55e" style={{ font: "bold 16px monospace" }}>
              {advPct}%
            </text>
            <text x={cx} y={cy + 9} textAnchor="middle" fill="rgba(255,255,255,0.4)" style={{ font: "8px monospace" }}>
              ADVANCE
            </text>
          </svg>
        </div>

        {/* Stats */}
        <div className="flex-1 space-y-1.5 text-[11px]">
          <Row label="Symbol" value={b.advancing.toLocaleString()} tone="text-emerald-400" sub="Advancing" />
          <Row label="" value={b.declining.toLocaleString()} tone="text-rose-400" sub="Declining" />
          <Row label="" value={b.unchanged.toLocaleString()} tone="text-white/65" sub="Unchanged" />
          <div className="border-t border-white/[0.04] pt-1 text-[11px]">
            <div className="flex items-center justify-between">
              <span className="text-white/45">A/D Ratio</span>
              <span className={`font-mono text-sm font-bold ${b.adRatio >= 1 ? "text-emerald-400" : "text-rose-400"}`}>
                {b.adRatio}
              </span>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

function Row({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone: string;
  sub?: string;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[10px] text-white/45">{sub || label}</span>
      <span className={`font-mono text-sm font-bold ${tone}`}>{value}</span>
    </div>
  );
}
