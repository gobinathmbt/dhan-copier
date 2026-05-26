import type { IntelSnapshot } from "@/lib/intelTypes";
import { Panel } from "./Panel";
import { regimeColor } from "./colors";

function Chip({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div
      className="flex flex-col gap-0.5 rounded-md border bg-black/30 px-2.5 py-1.5"
      style={{ borderColor: `${color}30` }}
    >
      <span className="text-[8px] font-semibold uppercase tracking-[0.14em] text-white/40">
        {label}
      </span>
      <span className="text-xs font-bold uppercase tracking-wide" style={{ color }}>
        {(value || "—").replace(/_/g, " ")}
      </span>
    </div>
  );
}

export function RegimeStrip({ data }: { data: IntelSnapshot | null }) {
  if (!data) return null;
  return (
    <Panel title="Regime Stack" dense className="h-full">
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-7">
        <Chip
          label="Market"
          value={data.regime.market}
          color={regimeColor(data.regime.market)}
        />
        <Chip
          label="Volatility"
          value={data.regime.volatility}
          color={regimeColor(data.regime.volatility)}
        />
        <Chip
          label="Meta"
          value={data.regime.meta}
          color={regimeColor(data.regime.meta)}
        />
        <Chip
          label="Gamma"
          value={data.regime.gamma}
          color={data.regime.gamma === "negative" ? "#ef4444" : data.regime.gamma === "positive" ? "#a855f7" : "#9ca3af"}
        />
        <Chip
          label="Orderflow"
          value={data.regime.orderflow}
          color={regimeColor(data.regime.orderflow)}
        />
        <Chip
          label="MTF"
          value={data.regime.mtfStructure}
          color={regimeColor(data.regime.mtfStructure)}
        />
        <Chip
          label="Aggression"
          value={data.regime.aggressionMode}
          color="#3b82f6"
        />
      </div>
    </Panel>
  );
}
