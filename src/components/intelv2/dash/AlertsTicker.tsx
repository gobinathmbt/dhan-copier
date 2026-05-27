import type { IntelV2Snapshot } from "@/lib/intelV2Types";
import { V2_TONE } from "./common";
import { Activity } from "lucide-react";

export function AlertsTickerV2({ data }: { data: IntelV2Snapshot | null }) {
  const alerts = data?.dashboard?.liveAlerts || [];
  return (
    <div className="flex h-9 shrink-0 items-center gap-3 overflow-hidden border-t border-white/[0.06] bg-[#0a0d12] px-3">
      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-emerald-400">
        <Activity size={12} />
        Live Alerts
      </div>
      <div className="flex flex-1 items-center gap-5 overflow-hidden text-[12px]">
        {alerts.length === 0 ? (
          <span className="text-white/45">No alerts</span>
        ) : (
          alerts.map((a, i) => {
            const c = V2_TONE[a.tone].color;
            return (
              <span key={i} className="flex shrink-0 items-center gap-1.5">
                <span className="font-mono text-white/45">{a.time}</span>
                <span className="font-bold" style={{ color: c }}>{a.label}</span>
                <span className="text-white/65">{a.detail}</span>
                <span className="font-mono font-bold" style={{ color: c }}>{a.value}</span>
              </span>
            );
          })
        )}
      </div>
      <span className="font-mono text-[10px] text-white/45">
        Source: {data?.dataSource || "—"}
      </span>
    </div>
  );
}
