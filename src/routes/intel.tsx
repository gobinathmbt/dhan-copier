import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { isAuthenticated } from "@/lib/auth";
import { useIntelSnapshot } from "@/hooks/useIntelSnapshot";
import type { SymbolKey } from "@/lib/intelTypes";
import { TopBar } from "@/components/intel/TopBar";
import { PremiumHealthPanel } from "@/components/intel/PremiumHealthCard";
import { FlowEnginePanel } from "@/components/intel/FlowEnginePanel";
import { MiniChart } from "@/components/intel/MiniChart";
import { StrikeLadder } from "@/components/intel/StrikeLadder";
import { RegimeStrip } from "@/components/intel/RegimeStrip";
import { ExecutionTerminal } from "@/components/intel/ExecutionTerminal";
import { DebugPanel } from "@/components/intel/DebugPanel";
import { cn } from "@/lib/utils";
import { Wifi, WifiOff, RefreshCw } from "lucide-react";

export const Route = createFileRoute("/intel")({
  component: IntelPage,
});

const SYMBOLS: { key: SymbolKey; label: string }[] = [
  { key: "NIFTY_50", label: "NIFTY 50" },
  { key: "SENSEX", label: "SENSEX" },
];

function IntelPage() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!isAuthenticated()) {
      navigate({ to: "/login" });
    }
  }, [navigate]);

  const [symbol, setSymbol] = useState<SymbolKey>("NIFTY_50");
  const [intervalMs, setIntervalMs] = useState(2000);

  const { data, loading, error, lastFetchAt, refetch } = useIntelSnapshot({
    symbol,
    intervalMs,
  });

  const stale = lastFetchAt && Date.now() - lastFetchAt > 6000;

  return (
    <div
      className="relative min-h-[calc(100vh-4rem)] w-full bg-[#0a0a0b] text-white"
      style={{
        backgroundImage:
          "radial-gradient(circle at 50% -20%, rgba(168,85,247,0.06), transparent 50%), radial-gradient(circle at 100% 100%, rgba(59,130,246,0.04), transparent 60%)",
      }}
    >
      {/* Header strip */}
      <div className="sticky top-0 z-30 flex items-center gap-2 border-b border-white/[0.06] bg-[#0a0a0b]/85 px-4 py-2 backdrop-blur-md">
        <h1 className="text-sm font-bold uppercase tracking-[0.18em] text-white/85">
          Intel Terminal
        </h1>
        <span className="text-[10px] text-white/35">institutional intraday options intelligence</span>

        <div className="ml-4 flex items-center gap-1 rounded-md border border-white/[0.08] bg-black/30 p-0.5">
          {SYMBOLS.map((s) => (
            <button
              key={s.key}
              onClick={() => setSymbol(s.key)}
              className={cn(
                "rounded px-3 py-1 text-[11px] font-semibold uppercase tracking-wider transition-colors",
                symbol === s.key
                  ? "bg-white/10 text-white"
                  : "text-white/45 hover:text-white/85",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-3 text-[10px] text-white/55">
          <select
            value={intervalMs}
            onChange={(e) => setIntervalMs(Number(e.target.value))}
            className="rounded border border-white/[0.08] bg-black/30 px-2 py-1 text-[10px] text-white/85"
          >
            <option value={1000}>1s</option>
            <option value={2000}>2s</option>
            <option value={5000}>5s</option>
            <option value={15000}>15s</option>
          </select>

          <button
            onClick={() => refetch()}
            className="flex items-center gap-1 rounded border border-white/[0.08] px-2 py-1 hover:bg-white/[0.04]"
            disabled={loading}
          >
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
            refresh
          </button>

          <span className="flex items-center gap-1">
            {data?.ok && !error ? (
              <>
                <Wifi size={11} className={cn("text-emerald-400", stale && "text-amber-400")} />
                <span className={stale ? "text-amber-400" : "text-emerald-400"}>
                  {stale ? "stale" : "live"}
                </span>
              </>
            ) : (
              <>
                <WifiOff size={11} className="text-rose-400" />
                <span className="text-rose-400">offline</span>
              </>
            )}
          </span>
          {data?.market.isOpen ? (
            <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-emerald-400">market open</span>
          ) : (
            <span className="rounded bg-rose-500/15 px-2 py-0.5 text-rose-400">market closed</span>
          )}
        </div>
      </div>

      {error ? (
        <div className="mx-4 mt-3 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {error}
        </div>
      ) : null}

      <div className="space-y-3 p-3">
        {/* Top widgets */}
        <TopBar data={data} />

        {/* Regime strip */}
        <RegimeStrip data={data} />

        {/* Main grid: left CE/PE health, center chart, right flow */}
        <div className="grid gap-3 lg:grid-cols-12">
          <div className="lg:col-span-3 lg:max-h-[640px]">
            <PremiumHealthPanel data={data} />
          </div>
          <div className="lg:col-span-6 lg:max-h-[640px]">
            <MiniChart data={data} />
          </div>
          <div className="lg:col-span-3 lg:max-h-[640px]">
            <FlowEnginePanel data={data} />
          </div>
        </div>

        {/* Strike ladder + execution terminal */}
        <div className="grid gap-3 lg:grid-cols-12">
          <div className="lg:col-span-6">
            <StrikeLadder data={data} />
          </div>
          <div className="lg:col-span-6">
            <ExecutionTerminal data={data} />
          </div>
        </div>

        {/* Debug */}
        <DebugPanel
          data={data}
          lastFetchAt={lastFetchAt}
          loading={loading}
          error={error}
        />
      </div>
    </div>
  );
}
