import { useState } from "react";
import type { IntelSnapshot } from "@/lib/intelTypes";
import { Panel, StatRow } from "./Panel";
import { ChevronDown, ChevronRight, Bug } from "lucide-react";
import { cn } from "@/lib/utils";

export function DebugPanel({
  data,
  lastFetchAt,
  loading,
  error,
}: {
  data: IntelSnapshot | null;
  lastFetchAt: number | null;
  loading: boolean;
  error: string | null;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Panel
      title={
        <div className="flex items-center gap-1.5">
          <Bug size={11} />
          <span>Debug · Engine States</span>
        </div>
      }
      badge={
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-[10px] text-white/45 hover:text-white/85"
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
      }
      className={cn("transition-all", !open && "h-12")}
    >
      {!open ? null : data ? (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/40">
              Connection
            </div>
            <StatRow label="Last fetch" value={lastFetchAt ? new Date(lastFetchAt).toLocaleTimeString() : "—"} />
            <StatRow label="Loading" value={loading ? "yes" : "no"} tone={loading ? "info" : "neutral"} />
            <StatRow label="Error" value={error || "—"} tone={error ? "bear" : "neutral"} />
            <StatRow label="Backend latency" value={data.at ? `${Date.now() - data.at}ms` : "—"} />
          </div>

          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/40">
              Candles
            </div>
            <StatRow label="1m" value={data.debug.candleCounts["1m"] ?? "—"} />
            <StatRow label="5m" value={data.debug.candleCounts["5m"] ?? "—"} />
            <StatRow label="15m" value={data.debug.candleCounts["15m"] ?? "—"} />
            <StatRow label="30m" value={data.debug.candleCounts["30m"] ?? "—"} />
          </div>

          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/40">
              Engines available
            </div>
            <StatRow label="Tick delta" value={data.debug.tickDeltaActive ? "live" : "—"} tone={data.debug.tickDeltaActive ? "bull" : "neutral"} />
            <StatRow label="Microstructure" value={data.debug.microstructureAvailable ? "yes" : "—"} />
            <StatRow label="Futures lead" value={data.debug.futuresLeadAvailable ? "yes" : "—"} />
            <StatRow label="Delta velocity" value={data.debug.deltaAvailable ? "yes" : "—"} />
          </div>

          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/40">
              Engine routing
            </div>
            <StatRow label="Mode" value={data.debug.executionMode} />
            <StatRow label="Ultra Scalp" value={data.debug.activeEngines.ultraScalp ? "ON" : "OFF"} />
            <StatRow label="Support Scalp" value={data.debug.activeEngines.supportScalp ? "ON" : "OFF"} tone={data.debug.activeEngines.supportScalp ? "bull" : "neutral"} />
            <StatRow label="Premium Swing" value={data.debug.activeEngines.premiumSwing ? "ON" : "OFF"} />
            <StatRow label="Core" value={data.debug.activeEngines.core ? "ON" : "OFF"} />
          </div>

          <div className="md:col-span-2 lg:col-span-4">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/40">
              Bias reasoning
            </div>
            <div className="rounded border border-white/[0.06] bg-black/30 p-2 font-mono text-[10px] text-white/65">
              {data.bias.reasoning || "—"}
            </div>
          </div>

          {data.trap.reasoning ? (
            <div className="md:col-span-2 lg:col-span-4">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/40">
                Trap detector reasoning
              </div>
              <div className="rounded border border-amber-500/20 bg-amber-500/5 p-2 font-mono text-[10px] text-amber-200/85">
                {data.trap.reasoning}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}
