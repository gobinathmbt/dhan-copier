import type { IntelV2Snapshot } from "@/lib/intelV2Types";
import { V2Card, V2Pill } from "./common";
import { cn } from "@/lib/utils";

type StrikeRow = NonNullable<IntelV2Snapshot["dashboard"]>["topStrikeSelections"]["ce"][number];

export function TopStrikeCardV2({ data }: { data: IntelV2Snapshot | null }) {
  if (!data) return <V2Card title="Top Strike Selection">…</V2Card>;
  const sel = data.dashboard?.topStrikeSelections;
  const ceRows = sel?.ce || [];
  const peRows = sel?.pe || [];

  return (
    <V2Card title="Top Strike Selection">
      <div className="grid h-full grid-cols-2 gap-3 overflow-hidden">
        <SideColumn label="CALLS (BUY CE)" tone="bull" rows={ceRows} />
        <SideColumn label="PUTS (BUY PE)" tone="bear" rows={peRows} />
      </div>
    </V2Card>
  );
}

function SideColumn({
  label,
  tone,
  rows,
}: {
  label: string;
  tone: "bull" | "bear";
  rows: StrikeRow[];
}) {
  const labelColor = tone === "bull" ? "text-emerald-400" : "text-rose-400";
  return (
    <div className="flex min-h-0 flex-col">
      <div className={cn("mb-1.5 text-center text-[11px] font-bold uppercase tracking-[0.18em]", labelColor)}>
        {label}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-white/[0.06] text-[10px] uppercase tracking-wider text-white/45">
              <th className="py-1.5 text-left">Strike</th>
              <th className="py-1.5 text-left">Type</th>
              <th className="py-1.5 text-right">Score</th>
              <th className="py-1.5 text-right">Conf</th>
              <th className="py-1.5 pl-1 text-left">Reason</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((r) => {
                const t = r.type === "BUY" ? "bull" : r.type === "AVOID" ? "bear" : "warn";
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
                    <td className="py-1.5 font-mono text-[13px] font-bold text-white">{r.strike}</td>
                    <td className="py-1.5">
                      <V2Pill label={r.type} tone={t as "bull" | "bear" | "warn"} size="sm" />
                    </td>
                    <td className="py-1.5 text-right font-mono text-white/85">{r.score}</td>
                    <td className="py-1.5 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <div className="relative h-1.5 w-10 overflow-hidden rounded-full bg-white/[0.08]">
                          <div className="absolute inset-y-0 left-0" style={{ width: `${conf}%`, background: confColor }} />
                        </div>
                        <span className="font-mono text-[11px] tabular-nums text-white/85">{conf}%</span>
                      </div>
                    </td>
                    <td className="py-1.5 pl-1 text-[11px] text-white/65">{r.reason}</td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={5} className="py-4 text-center text-[12px] text-white/35">
                  no candidates
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
