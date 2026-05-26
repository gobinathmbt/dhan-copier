import type { IntelSnapshot } from "@/lib/intelTypes";
import { ChevronRight } from "lucide-react";

export function AlertsTicker({ data }: { data: IntelSnapshot | null }) {
  const alerts = data?.dashboard?.liveAlerts || [];
  return (
    <div className="flex h-9 shrink-0 items-center justify-between border-t border-white/[0.06] bg-[#0a0d12] px-3 text-[11px]">
      <div className="flex items-center gap-2 text-emerald-400">
        <span className="text-[10px] font-bold uppercase tracking-[0.18em]">LIVE ALERTS</span>
      </div>
      <div className="flex flex-1 items-center gap-5 overflow-x-auto px-4">
        {alerts.length ? (
          alerts.map((a, i) => (
            <div key={i} className="flex shrink-0 items-center gap-2 whitespace-nowrap text-[10px]">
              <span className="font-mono text-white/45">{a.time}</span>
              <span
                className="font-bold uppercase"
                style={{
                  color:
                    a.tone === "bull"
                      ? "#22c55e"
                      : a.tone === "bear"
                        ? "#ef4444"
                        : a.tone === "warn"
                          ? "#f59e0b"
                          : "#9ca3af",
                }}
              >
                {a.label}
              </span>
              <span className="text-white/55">{a.detail}</span>
              <span
                className="font-mono font-bold"
                style={{
                  color:
                    a.tone === "bull"
                      ? "#22c55e"
                      : a.tone === "bear"
                        ? "#ef4444"
                        : "#f59e0b",
                }}
              >
                {a.value}
              </span>
            </div>
          ))
        ) : (
          <span className="text-white/30">No live alerts</span>
        )}
      </div>
      <button className="flex items-center gap-1 text-[10px] text-emerald-400 hover:text-emerald-300">
        View All Alerts
        <ChevronRight size={11} />
      </button>
    </div>
  );
}
