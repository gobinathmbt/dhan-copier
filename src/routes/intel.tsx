import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { isAuthenticated } from "@/lib/auth";
import { useIntelSnapshot } from "@/hooks/useIntelSnapshot";
import type { SymbolKey } from "@/lib/intelTypes";

import { TopHeader } from "@/components/intel/dash/TopHeader";
import { StatusStrip } from "@/components/intel/dash/StatusStrip";
import { SpotFutCard } from "@/components/intel/dash/SpotFutCard";
import { OiAnalysisCard } from "@/components/intel/dash/OiAnalysisCard";
import { DeltaVolumeCard } from "@/components/intel/dash/DeltaVolumeCard";
import { FrvpCard } from "@/components/intel/dash/FrvpCard";
import { BreadthCard } from "@/components/intel/dash/BreadthCard";
import { HeavyweightsCard } from "@/components/intel/dash/HeavyweightsCard";
import { IvCard } from "@/components/intel/dash/IvCard";
import { TrapDetectorCard, MarketRegimeCard } from "@/components/intel/dash/TrapAndRegimeCard";
import { SupportResistanceCard } from "@/components/intel/dash/SupportResistanceCard";
import { TopStrikeCard } from "@/components/intel/dash/TopStrikeCard";
import { RiskCard } from "@/components/intel/dash/RiskCard";
import { AlertsTicker } from "@/components/intel/dash/AlertsTicker";

export const Route = createFileRoute("/intel")({
  component: IntelPage,
});

function IntelPage() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!isAuthenticated()) {
      navigate({ to: "/login" });
    }
  }, [navigate]);

  const [symbol, setSymbol] = useState<SymbolKey>("NIFTY_50");
  const { data } = useIntelSnapshot({ symbol, intervalMs: 2000 });

  return (
    <div className="fixed inset-0 left-16 flex flex-col bg-[#070a0e] text-white">
      <TopHeader data={data} symbol={symbol} onSymbol={setSymbol} />
      <main className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-2">
        <StatusStrip data={data} />

        {/* Row 2 — 4 quad cards */}
        <div
          className="grid min-h-0 grid-cols-12 gap-2"
          style={{ flex: "0 0 240px", height: 240 }}
        >
          <div className="col-span-3 min-h-0 overflow-hidden"><SpotFutCard data={data} /></div>
          <div className="col-span-3 min-h-0 overflow-hidden"><OiAnalysisCard data={data} /></div>
          <div className="col-span-3 min-h-0 overflow-hidden"><DeltaVolumeCard data={data} /></div>
          <div className="col-span-3 min-h-0 overflow-hidden"><FrvpCard data={data} /></div>
        </div>

        {/* Row 3 — Breadth, Heavyweights pie, IV, Trap, Regime */}
        <div
          className="grid min-h-0 grid-cols-12 gap-2"
          style={{ flex: "0 0 200px", height: 200 }}
        >
          <div className="col-span-2 min-h-0 overflow-hidden"><BreadthCard data={data} /></div>
          <div className="col-span-3 min-h-0 overflow-hidden"><HeavyweightsCard data={data} /></div>
          <div className="col-span-3 min-h-0 overflow-hidden"><IvCard data={data} /></div>
          <div className="col-span-2 min-h-0 overflow-hidden"><TrapDetectorCard data={data} /></div>
          <div className="col-span-2 min-h-0 overflow-hidden"><MarketRegimeCard data={data} /></div>
        </div>

        {/* Row 4 — Support/Resistance + Top Strikes + Risk Management */}
        <div
          className="grid min-h-0 grid-cols-12 gap-2"
          style={{ flex: "1 1 0" }}
        >
          <div className="col-span-4 min-h-0 overflow-hidden"><SupportResistanceCard data={data} /></div>
          <div className="col-span-5 min-h-0 overflow-hidden"><TopStrikeCard data={data} /></div>
          <div className="col-span-3 min-h-0 overflow-hidden"><RiskCard data={data} /></div>
        </div>
      </main>
      <AlertsTicker data={data} />
    </div>
  );
}
