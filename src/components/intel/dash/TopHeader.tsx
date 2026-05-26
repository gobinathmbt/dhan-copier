import type { IntelSnapshot, SymbolKey } from "@/lib/intelTypes";
import { Bell, Settings, User, ChevronDown, Activity } from "lucide-react";
import { fmt, fmtSigned } from "./common";
import { cn } from "@/lib/utils";

export function TopHeader({
  data,
  symbol,
  onSymbol,
}: {
  data: IntelSnapshot | null;
  symbol: SymbolKey;
  onSymbol: (s: SymbolKey) => void;
}) {
  const istNow = new Date();
  const istTime = istNow.toLocaleTimeString("en-IN", { hour12: false });

  const spotChange = data?.spot.change ?? 0;
  const spotPct = data?.spot.changePct ?? 0;

  const fut = data?.futures.ltp ?? 0;
  const futChange = (fut && data?.spot.priorClose) ? Number((fut - data.spot.priorClose).toFixed(2)) : 0;
  const futPct = (data?.spot.priorClose && futChange) ? Number(((futChange / data.spot.priorClose) * 100).toFixed(2)) : 0;

  return (
    <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/[0.06] bg-[#0a0d12] px-4">
      {/* Logo */}
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-2">
          <Activity className="text-emerald-400" size={20} />
          <div>
            <div className="text-[13px] font-bold tracking-wider text-emerald-400">
              {symbol === "SENSEX" ? "SENSEX" : "NIFTY"} Console
            </div>
            <div className="text-[8px] uppercase tracking-[0.18em] text-white/35">
              Institutional Footprint Monitor
            </div>
          </div>
        </div>

        {/* Symbol toggle */}
        <div className="flex items-center gap-1 rounded-md bg-white/[0.04] p-0.5">
          {(["NIFTY_50", "SENSEX"] as const).map((s) => (
            <button
              key={s}
              onClick={() => onSymbol(s)}
              className={cn(
                "rounded px-3 py-1 text-[11px] font-bold tracking-wide transition-colors",
                symbol === s
                  ? "bg-sky-500/20 text-sky-300"
                  : "text-white/45 hover:text-white/85",
              )}
            >
              {s === "NIFTY_50" ? "NIFTY" : "SENSEX"}
            </button>
          ))}
        </div>
      </div>

      {/* Center: Spot / Fut / Premium / VIX */}
      <div className="flex items-center gap-7">
        <Quote
          label="Spot"
          value={fmt(data?.spot.ltp, 2)}
          changeAbs={spotChange}
          changePct={spotPct}
        />
        <Quote
          label={symbol === "SENSEX" ? "Sensex Fut" : "Nifty Fut"}
          value={fmt(fut, 2)}
          changeAbs={futChange}
          changePct={futPct}
        />
        <Quote
          label="Premium"
          value={fmt(data?.futures.basis, 2)}
          changePct={data?.futures.basis && data?.spot.ltp ? Number(((data.futures.basis / data.spot.ltp) * 100).toFixed(2)) : null}
        />
        <Quote
          label="India VIX"
          value={fmt(data?.dashboard?.ivAnalytics?.vix, 2)}
          changeAbs={data?.dashboard?.ivAnalytics?.vix && data?.dashboard?.ivAnalytics?.vixChangePct
            ? Number(((data.dashboard.ivAnalytics.vix * data.dashboard.ivAnalytics.vixChangePct) / 100).toFixed(2))
            : null}
          changePct={data?.dashboard?.ivAnalytics?.vixChangePct}
        />
      </div>

      {/* Right: Market Status + Time + Icons */}
      <div className="flex items-center gap-4">
        <div className="flex flex-col items-end">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-white/40">Market Status</span>
            <span
              className={cn(
                "rounded px-2 py-0.5 text-[10px] font-bold tracking-wider",
                data?.market.isOpen
                  ? "bg-emerald-500/20 text-emerald-400"
                  : "bg-rose-500/20 text-rose-400",
              )}
            >
              {data?.market.isOpen ? "OPEN" : "CLOSED"}
            </span>
          </div>
          <div className="font-mono text-[11px] text-white/65">{istTime}</div>
        </div>
        <div className="flex items-center gap-3 text-white/55">
          <Bell size={15} className="cursor-pointer hover:text-white/85" />
          <Settings size={15} className="cursor-pointer hover:text-white/85" />
          <User size={15} className="cursor-pointer hover:text-white/85" />
        </div>
      </div>
    </div>
  );
}

function Quote({
  label,
  value,
  changeAbs,
  changePct,
}: {
  label: string;
  value: string;
  changeAbs?: number | null;
  changePct?: number | null;
}) {
  const c = changeAbs ?? changePct ?? 0;
  const positive = c >= 0;
  return (
    <div className="flex flex-col items-center">
      <span className="text-[9px] uppercase tracking-[0.14em] text-white/40">{label}</span>
      <span className="font-mono text-base font-bold text-white">{value}</span>
      <span className={cn("font-mono text-[10px]", positive ? "text-emerald-400" : "text-rose-400")}>
        {changeAbs != null ? fmtSigned(changeAbs, 2) : ""}
        {changePct != null ? ` (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)` : ""}
      </span>
    </div>
  );
}
