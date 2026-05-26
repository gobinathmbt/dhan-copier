import type { IntelSnapshot } from "@/lib/intelTypes";
import { Panel } from "./Panel";
import { actionColor, biasColor, premiumStateColor, regimeColor, trapColor } from "./colors";
import { Target, Shield, AlertTriangle, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

function fmt(n: number | null | undefined, d = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

function StateBadge({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div
      className="flex flex-col items-start gap-0.5 rounded border bg-black/20 px-2.5 py-1.5"
      style={{ borderColor: `${color}30` }}
    >
      <span className="text-[8px] font-semibold uppercase tracking-[0.14em] text-white/40">
        {label}
      </span>
      <span
        className="text-xs font-bold uppercase leading-none tracking-wide"
        style={{ color }}
      >
        {value}
      </span>
    </div>
  );
}

export function ExecutionTerminal({ data }: { data: IntelSnapshot | null }) {
  if (!data) {
    return (
      <Panel title="Execution Terminal" className="h-full">
        <div className="flex h-full items-center justify-center text-xs text-white/30">
          loading…
        </div>
      </Panel>
    );
  }

  const action = data.action.action;
  const actionLabel =
    action === "BUY_CE"
      ? "BUY CALL"
      : action === "BUY_PE"
        ? "BUY PUT"
        : action === "WAIT"
          ? "WAIT"
          : "NO TRADE";

  const aColor = actionColor(action);

  // Derive entry/SL/target zones from current structure + bias
  const dir = data.bias.overallBias;
  const spot = data.spot.ltp;
  const vwap = data.spot.vwap;
  const poc = data.flow.volume.poc;
  const vah = data.flow.volume.vah;
  const val = data.flow.volume.val;
  const callWall = data.options.callWall;
  const putWall = data.options.putWall;

  const entryZone =
    dir === "bullish"
      ? `VWAP reclaim ${fmt(vwap, 2)} / VAL hold ${fmt(val, 2)}`
      : dir === "bearish"
        ? `VWAP rejection ${fmt(vwap, 2)} / VAH break ${fmt(vah, 2)}`
        : "wait for clear bias";

  const slZone =
    dir === "bullish"
      ? `Below ${fmt(Math.min(vwap || spot, val || spot, data.spot.openingRangeLow || spot), 2)}`
      : dir === "bearish"
        ? `Above ${fmt(Math.max(vwap || spot, vah || spot, data.spot.openingRangeHigh || spot), 2)}`
        : "—";

  const targetZone =
    dir === "bullish"
      ? `${fmt(vah, 2)} → ${fmt(callWall, 0)} (call wall) → ${fmt(data.spot.pdh, 2)} (PDH)`
      : dir === "bearish"
        ? `${fmt(val, 2)} → ${fmt(putWall, 0)} (put wall) → ${fmt(data.spot.pdl, 2)} (PDL)`
        : "—";

  return (
    <Panel
      title="Execution Terminal"
      badge={
        <span className="font-mono text-[10px] text-white/40">
          ATM {data.options.atm} · {data.market.phase}
        </span>
      }
      className="h-full"
    >
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
        {/* Big action card */}
        <div
          className={cn(
            "lg:col-span-3 flex flex-col items-center justify-center gap-1 rounded-lg border-2 p-4 text-center",
            (action === "BUY_CE" || action === "BUY_PE") && "shadow-[0_0_32px_-6px_currentColor] animate-pulse",
          )}
          style={{
            borderColor: `${aColor}80`,
            background: `${aColor}12`,
            color: aColor,
          }}
        >
          <span className="text-[9px] font-semibold uppercase tracking-[0.2em] text-white/50">
            Action
          </span>
          <span className="text-2xl font-bold leading-none" style={{ color: aColor }}>
            {actionLabel}
          </span>
          <span className="text-[10px] text-white/55">{data.action.reason}</span>
          <div className="mt-2 grid w-full grid-cols-2 gap-1 border-t border-white/[0.08] pt-2 text-[10px]">
            <div className="flex flex-col">
              <span className="text-white/40">Confidence</span>
              <span className="font-mono font-bold text-white/85">{data.confidence.winning}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-white/40">Bias score</span>
              <span className="font-mono font-bold text-white/85">{data.bias.directionScore}</span>
            </div>
          </div>
        </div>

        {/* State badges */}
        <div className="lg:col-span-5">
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            <StateBadge
              label="Market"
              value={(data.regime.market || "—").replace(/_/g, " ")}
              color={regimeColor(data.regime.market)}
            />
            <StateBadge
              label="Smart Money"
              value={(data.bias.smartMoney || "neutral").replace(/_/g, " ")}
              color={biasColor(data.bias.overallBias)}
            />
            <StateBadge
              label="Futures"
              value={data.futures.leadLagScore > 60 ? "leading" : data.futures.leadLagScore < 40 ? "lagging" : "synced"}
              color={data.futures.leadLagScore > 60 ? "#10b981" : data.futures.leadLagScore < 40 ? "#ef4444" : "#9ca3af"}
            />
            <StateBadge
              label="OI Bias"
              value={data.flow.oi.peWriting ? "PE writing" : data.flow.oi.ceWriting ? "CE writing" : "—"}
              color={data.flow.oi.peWriting ? "#10b981" : data.flow.oi.ceWriting ? "#ef4444" : "#9ca3af"}
            />
            <StateBadge
              label="Delta"
              value={data.flow.delta.bias === "bullish" ? "aggressive buy" : data.flow.delta.bias === "bearish" ? "aggressive sell" : "balanced"}
              color={biasColor(data.flow.delta.bias)}
            />
            <StateBadge
              label="CE Premium"
              value={data.premiumHealth.ce.state}
              color={premiumStateColor(data.premiumHealth.ce.state)}
            />
            <StateBadge
              label="PE Premium"
              value={data.premiumHealth.pe.state}
              color={premiumStateColor(data.premiumHealth.pe.state)}
            />
            <StateBadge
              label="Trap Risk"
              value={data.trap.risk}
              color={trapColor(data.trap.risk)}
            />
          </div>
        </div>

        {/* Zones */}
        <div className="lg:col-span-4 space-y-2">
          <ZoneRow
            icon={<ArrowRight size={12} />}
            label="Entry"
            value={entryZone}
            color="#3b82f6"
          />
          <ZoneRow
            icon={<Shield size={12} />}
            label="SL Zone"
            value={slZone}
            color="#ef4444"
          />
          <ZoneRow
            icon={<Target size={12} />}
            label="Targets"
            value={targetZone}
            color="#10b981"
          />
          {data.trap.score >= 30 ? (
            <ZoneRow
              icon={<AlertTriangle size={12} />}
              label="Caution"
              value={data.trap.reasoning}
              color="#f59e0b"
              tight
            />
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

function ZoneRow({
  icon,
  label,
  value,
  color,
  tight,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: string;
  tight?: boolean;
}) {
  return (
    <div
      className="flex items-start gap-2 rounded border bg-black/20 p-2"
      style={{ borderColor: `${color}30` }}
    >
      <span className="mt-0.5" style={{ color }}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-white/45">
          {label}
        </div>
        <div
          className={cn("text-xs font-mono text-white/85", tight ? "truncate" : "")}
          title={value}
        >
          {value}
        </div>
      </div>
    </div>
  );
}
