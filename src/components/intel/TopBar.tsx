import { TrendingUp, TrendingDown, AlertTriangle, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { actionColor, biasColor, regimeColor, trapColor } from "./colors";
import type { IntelSnapshot } from "@/lib/intelTypes";

function fmt(n: number, d = 2) {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

function ConfidenceMeter({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, score));
  const color = pct >= 70 ? "#10b981" : pct >= 50 ? "#f59e0b" : "#ef4444";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[9px] uppercase tracking-[0.14em] text-white/40">Confidence</span>
        <span className="font-mono text-2xl font-bold tabular-nums" style={{ color }}>
          {pct}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.08]">
        <div
          className="h-full transition-all duration-500"
          style={{ width: `${pct}%`, background: color, boxShadow: `0 0 12px ${color}` }}
        />
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  tone = "#9ca3af",
  icon,
  pulse,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
  icon?: React.ReactNode;
  pulse?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative flex flex-col gap-1 rounded-lg border bg-[#111114]/80 px-3 py-2 backdrop-blur-sm transition-all",
        pulse && "shadow-[0_0_24px_-6px_currentColor]",
      )}
      style={{
        borderColor: `${tone}40`,
        color: tone,
      }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-white/40">
          {label}
        </span>
        {icon ? <span className="text-current opacity-70">{icon}</span> : null}
      </div>
      <span className="text-base font-bold leading-tight" style={{ color: tone }}>
        {value}
      </span>
      {sub ? <span className="text-[10px] text-white/45">{sub}</span> : null}
      {pulse ? (
        <span
          className="pointer-events-none absolute inset-0 rounded-lg ring-2 animate-pulse"
          style={{ borderColor: tone }}
        />
      ) : null}
    </div>
  );
}

export function TopBar({ data }: { data: IntelSnapshot | null }) {
  if (!data || !data.ok) {
    return (
      <div className="grid grid-cols-7 gap-2">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg bg-white/[0.04]" />
        ))}
      </div>
    );
  }

  const regimeLabel = (data.regime.market || "—").replace(/_/g, " ");
  const metaLabel = (data.regime.meta || "").replace(/_/g, " ");
  const smartMoneyLabel = (data.bias.smartMoney || "neutral").replace(/_/g, " ");

  const ceState = data.premiumHealth.ce.state;
  const peState = data.premiumHealth.pe.state;

  const action = data.action.action;
  const actionLabel =
    action === "BUY_CE"
      ? "BUY CE"
      : action === "BUY_PE"
        ? "BUY PE"
        : action === "WAIT"
          ? "WAIT"
          : "NO TRADE";

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7">
      {/* Spot price */}
      <Tile
        label={data.displayName + " Spot"}
        value={fmt(data.spot.ltp, 2)}
        sub={
          data.spot.changePct
            ? `${data.spot.changePct >= 0 ? "+" : ""}${fmt(data.spot.changePct, 2)}%`
            : data.market.phase
        }
        tone={data.spot.changePct >= 0 ? "#10b981" : "#ef4444"}
        icon={data.spot.changePct >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
      />

      {/* Market regime */}
      <Tile
        label="Market Regime"
        value={regimeLabel}
        sub={metaLabel || data.regime.volatility}
        tone={regimeColor(data.regime.market)}
        icon={<Sparkles size={14} />}
      />

      {/* Smart money */}
      <Tile
        label="Smart Money"
        value={smartMoneyLabel}
        sub={`Strength ${data.bias.smartMoneyStrength}/100`}
        tone={
          data.bias.smartMoney.includes("buyer")
            ? "#10b981"
            : data.bias.smartMoney.includes("seller")
              ? "#ef4444"
              : data.bias.smartMoney === "absorption"
                ? "#3b82f6"
                : "#9ca3af"
        }
        pulse={data.bias.smartMoneyStrength >= 80}
      />

      {/* Premium health CE / PE */}
      <Tile
        label="Premium Health"
        value={`CE ${ceState.toUpperCase()}`}
        sub={`PE ${peState.toUpperCase()} · CE ${data.premiumHealth.ce.score}/100 · PE ${data.premiumHealth.pe.score}/100`}
        tone={biasColor(data.bias.overallBias)}
        icon={<Zap size={14} />}
      />

      {/* Trap risk */}
      <Tile
        label="Trap Risk"
        value={data.trap.risk.toUpperCase()}
        sub={`Score ${data.trap.score}/100`}
        tone={trapColor(data.trap.risk)}
        icon={<AlertTriangle size={14} />}
        pulse={data.trap.risk === "high"}
      />

      {/* Confidence meter */}
      <div className="flex flex-col justify-center rounded-lg border border-white/[0.08] bg-[#111114]/80 px-3 py-2 backdrop-blur-sm">
        <ConfidenceMeter score={data.confidence.winning} />
      </div>

      {/* Best action */}
      <Tile
        label="Best Action"
        value={actionLabel}
        sub={data.action.reason}
        tone={actionColor(action)}
        icon={<ShieldCheck size={14} />}
        pulse={action === "BUY_CE" || action === "BUY_PE"}
      />
    </div>
  );
}
