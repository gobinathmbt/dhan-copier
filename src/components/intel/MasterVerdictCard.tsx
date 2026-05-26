import type { IntelSnapshot } from "@/lib/intelTypes";
import { Panel } from "./Panel";
import { TrendingUp, TrendingDown, Minus, ShieldCheck, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

function fmt(n: number | null | undefined, d = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

const VERDICT_COLORS: Record<string, string> = {
  STRONG_BULLISH: "#10b981",
  BULLISH: "#22c55e",
  NEUTRAL: "#9ca3af",
  BEARISH: "#f97316",
  STRONG_BEARISH: "#ef4444",
};

const VERDICT_LABELS: Record<string, string> = {
  STRONG_BULLISH: "STRONG BULLISH",
  BULLISH: "BULLISH",
  NEUTRAL: "NEUTRAL",
  BEARISH: "BEARISH",
  STRONG_BEARISH: "STRONG BEARISH",
};

export function MasterVerdictCard({ data }: { data: IntelSnapshot | null }) {
  if (!data || !data.verdict) {
    return (
      <Panel title="Master Verdict" className="h-full">
        <div className="flex h-full items-center justify-center text-xs text-white/30">
          waiting for data…
        </div>
      </Panel>
    );
  }
  const v = data.verdict;
  const color = VERDICT_COLORS[v.verdict] || "#9ca3af";
  const label = VERDICT_LABELS[v.verdict] || v.verdict;
  const isStrong = v.verdict === "STRONG_BULLISH" || v.verdict === "STRONG_BEARISH";

  return (
    <Panel
      title="Master Verdict"
      badge={
        <span className="font-mono text-[10px] text-white/40">
          {data.displayName} · {data.market.phase}
        </span>
      }
      className="h-full"
    >
      <div className="flex flex-col gap-3">
        {/* Verdict pill */}
        <div
          className={cn(
            "relative flex flex-col items-center justify-center gap-1 rounded-lg border-2 p-4 text-center",
            isStrong && "shadow-[0_0_32px_-6px_currentColor] animate-pulse",
          )}
          style={{
            borderColor: `${color}90`,
            background: `${color}12`,
            color,
          }}
        >
          <div className="flex items-center gap-2">
            {v.verdict.includes("BULLISH") ? <TrendingUp size={16} /> :
             v.verdict.includes("BEARISH") ? <TrendingDown size={16} /> :
             <Minus size={16} />}
            <span className="text-xl font-bold tracking-wider" style={{ color }}>
              {label}
            </span>
          </div>
          <div className="mt-1 text-[10px] uppercase tracking-[0.2em] text-white/55">
            Buy {v.side === "NEUTRAL" ? "—" : v.side} side
          </div>
        </div>

        {/* CE vs PE probability split */}
        <div>
          <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-[0.14em] text-white/55">
            <span className="text-emerald-400">CE Probability</span>
            <span className="text-rose-400">PE Probability</span>
          </div>
          <div className="relative h-7 overflow-hidden rounded-md border border-white/[0.08] bg-black/40">
            <div
              className="absolute inset-y-0 left-0 flex items-center justify-start bg-emerald-500/30 px-2 transition-all duration-700"
              style={{ width: `${v.cePct}%` }}
            >
              <span className="font-mono text-xs font-bold text-emerald-300">
                {v.cePct.toFixed(1)}%
              </span>
            </div>
            <div
              className="absolute inset-y-0 right-0 flex items-center justify-end bg-rose-500/30 px-2 transition-all duration-700"
              style={{ width: `${v.pePct}%` }}
            >
              <span className="font-mono text-xs font-bold text-rose-300">
                {v.pePct.toFixed(1)}%
              </span>
            </div>
            <div
              className="absolute top-0 h-full w-px bg-white/40"
              style={{ left: "50%" }}
            />
          </div>
        </div>

        {/* Spot + change */}
        <div className="grid grid-cols-3 gap-2 border-t border-white/[0.06] pt-3">
          <Stat
            label="Spot"
            value={fmt(data.spot.ltp)}
            sub={
              <span className={cn(data.spot.changePct >= 0 ? "text-emerald-400" : "text-rose-400", "font-mono")}>
                {data.spot.changePct >= 0 ? "+" : ""}
                {fmt(data.spot.changePct, 2)}%
              </span>
            }
          />
          <Stat
            label="ATM"
            value={`${data.options.atm}`}
            sub={`Max Pain ${data.options.maxPain || "—"}`}
          />
          <Stat
            label="Confidence"
            value={`${data.confidence.winning.toFixed(0)}/100`}
            sub={`Bull ${data.confidence.bullish.toFixed(0)} · Bear ${data.confidence.bearish.toFixed(0)}`}
          />
        </div>
      </div>
    </Panel>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-white/[0.06] bg-black/20 px-2 py-1.5">
      <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-white/40">
        {label}
      </span>
      <span className="font-mono text-sm font-bold text-white">{value}</span>
      {sub ? <span className="text-[10px] text-white/55">{sub}</span> : null}
    </div>
  );
}

export function TradePlanCard({ data }: { data: IntelSnapshot | null }) {
  if (!data) {
    return (
      <Panel title="Best Trade" className="h-full">
        <div className="flex h-full items-center justify-center text-xs text-white/30">
          loading…
        </div>
      </Panel>
    );
  }
  const plan = data.tradePlan;
  if (!plan?.pick) {
    return (
      <Panel title="Best Trade" className="h-full">
        <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
          <AlertCircle className="text-amber-400" size={24} />
          <div className="text-base font-bold text-amber-300">{plan?.action || "NO_TRADE"}</div>
          <div className="text-xs text-white/50">{plan?.reason || "no clear setup"}</div>
        </div>
      </Panel>
    );
  }
  const pick = plan.pick;
  const isCE = pick.side === "CE";
  const sideColor = isCE ? "#10b981" : "#ef4444";

  return (
    <Panel
      title="Best Trade Plan"
      badge={<span className="font-mono text-[10px] text-white/40">{pick.moneyness}</span>}
      className="h-full"
    >
      <div className="flex flex-col gap-2">
        <div
          className="flex flex-col gap-1 rounded-lg border-2 p-3 text-center"
          style={{
            borderColor: `${sideColor}80`,
            background: `${sideColor}10`,
          }}
        >
          <div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-white/50">
            {plan.action.replace("_", " ")}
          </div>
          <div className="text-2xl font-bold tracking-wide" style={{ color: sideColor }}>
            {pick.strike} {pick.side}
          </div>
          <div className="font-mono text-base text-white">@ {fmt(pick.ltp, 2)}</div>
          {pick.health ? (
            <div className="text-[10px] text-white/55">
              Premium {pick.health.state.toUpperCase()} ({pick.health.score}/100)
            </div>
          ) : null}
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          <Box label="Target" value={fmt(pick.target, 2)} sub={`+${fmt(pick.targetPts, 2)}`} tone="bull" />
          <Box label="Stop" value={fmt(pick.sl, 2)} sub={`-${fmt(pick.slPts, 2)}`} tone="bear" />
          <Box label="R:R" value={`1:${fmt(pick.rr, 2)}`} tone="info" />
        </div>

        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 rounded border border-white/[0.06] bg-black/20 p-2">
          <Mini label="Δ" value={fmt(pick.delta, 2)} />
          <Mini label="IV" value={fmt(pick.iv, 1)} />
          <Mini label="OI" value={pick.oi.toLocaleString()} />
          <Mini label="Γ" value={fmt(pick.gamma, 4)} />
          <Mini label="Θ" value={fmt(pick.theta, 2)} />
        </div>

        <div className="text-[10px] italic text-white/45">{plan.reason}</div>
      </div>
    </Panel>
  );
}

function Box({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "bull" | "bear" | "info";
}) {
  const color = tone === "bull" ? "#10b981" : tone === "bear" ? "#ef4444" : "#3b82f6";
  return (
    <div className="flex flex-col rounded-md border bg-black/30 px-2 py-1.5" style={{ borderColor: `${color}30` }}>
      <span className="text-[9px] uppercase tracking-wider text-white/40">{label}</span>
      <span className="font-mono text-sm font-bold" style={{ color }}>
        {value}
      </span>
      {sub ? <span className="text-[10px] font-mono text-white/55">{sub}</span> : null}
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-white/45">{label}</span>
      <span className="font-mono font-semibold text-white/85">{value}</span>
    </div>
  );
}
