import type { IntelSnapshot } from "@/lib/intelTypes";
import { Card, Pill } from "./common";
import { cn } from "@/lib/utils";

export function TopStrikeCard({ data }: { data: IntelSnapshot | null }) {
  if (!data) return <Card title="Top Strike Selection">…</Card>;
  const rows = data.dashboard?.topStrikeSelections || [];

  return (
    <Card title="Top Strike Selection">
      <div className="h-full overflow-y-auto">
        <table className="w-full text-[11px]">
        <thead>
          <tr className="border-b border-white/[0.06] text-[8px] uppercase tracking-wider text-white/35">
            <th className="py-1 text-left">Strike</th>
            <th className="py-1 text-left">Type</th>
            <th className="py-1 text-left">Score</th>
            <th className="py-1 text-right">Confidence</th>
            <th className="py-1 text-left pl-2">Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const tone = r.type === "BUY" ? "bull" : r.type === "AVOID" ? "bear" : "warn";
            const conf = r.confidence;
            const confColor = conf >= 75 ? "#22c55e" : conf >= 55 ? "#84cc16" : conf >= 40 ? "#f59e0b" : "#ef4444";
            return (
              <tr
                key={`${r.strike}-${r.side}`}
                className={cn(
                  "border-b border-white/[0.03]",
                  r.type === "BUY" && "bg-emerald-500/5",
                  r.type === "AVOID" && "bg-rose-500/5",
                )}
              >
                <td className="py-1 font-mono font-bold text-white">{r.strike} {r.side}</td>
                <td className="py-1">
                  <Pill label={r.type} tone={tone as "bull" | "bear" | "warn"} size="xs" />
                </td>
                <td className="py-1 font-mono text-white/85">{r.score}</td>
                <td className="py-1 text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    <div className="relative h-1 w-12 overflow-hidden rounded-full bg-white/[0.08]">
                      <div
                        className="absolute inset-y-0 left-0"
                        style={{ width: `${conf}%`, background: confColor }}
                      />
                    </div>
                    <span className="font-mono text-[10px] tabular-nums text-white/85">{conf}%</span>
                  </div>
                </td>
                <td className="py-1 pl-2 text-[10px] text-white/55">{r.reason}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </Card>
  );
}
