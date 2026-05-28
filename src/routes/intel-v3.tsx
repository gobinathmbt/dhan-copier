import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { isAuthenticated } from "@/lib/auth";
import { useIntelV3Snapshot, fetchAvailableDatesV3 } from "@/hooks/useIntelV3Snapshot";
import type { IntelV3Symbol } from "@/lib/intelV3Types";

import { TopHeaderV3 } from "@/components/intelv3/TopHeaderV3";
import {
  MarketIntentCard,
  StrongResistanceCard,
  StrongSupportCard,
  BestOptionBuyCard,
  ShiftFlowCard,
  TrapRiskCard,
  AlternateScenarioCard,
  SmartMoneyFlowCard,
  SRQuickViewCard,
  TrendMomentumCard,
  KeyLevelsCard,
  ConfidenceMeterCard,
} from "@/components/intelv3/dashCards";

export const Route = createFileRoute("/intel-v3")({
  component: IntelV3Page,
});

function IntelV3Page() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!isAuthenticated()) navigate({ to: "/login" });
  }, [navigate]);

  const [symbol, setSymbol] = useState<IntelV3Symbol>("NIFTY_50");
  const [date, setDate] = useState<string | null>(null);
  const [availableDates, setAvailableDates] = useState<string[]>([]);

  const { data, loading, refetch, lastFetchAt } = useIntelV3Snapshot({
    symbol, date, intervalMs: 3000,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ds = await fetchAvailableDatesV3(symbol);
      if (!cancelled) setAvailableDates(ds);
    })();
    return () => { cancelled = true; };
  }, [symbol]);

  return (
    <div className="flex h-screen max-h-screen flex-col overflow-hidden bg-[#06080c] text-white">
      <TopHeaderV3
        data={data}
        symbol={symbol}
        onSymbol={setSymbol}
        date={date}
        onDate={setDate}
        availableDates={availableDates}
        loading={loading}
        lastFetchAt={lastFetchAt}
        onRefresh={refetch}
      />

      {/* Main grid — fills remaining space, no outer scroll */}
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 p-1.5">
        {/* Top row — col-span-12: Left intent+resistance | Center BestOptionBuy | Right shift+trap+alt */}
        <div className="grid min-h-0 flex-[3] grid-cols-12 gap-1.5">
          {/* LEFT — col-span-3: stacked Intent + Resistance + Support */}
          <div className="col-span-3 grid min-h-0 grid-rows-[1.1fr_1fr_1fr] gap-1.5">
            <MarketIntentCard data={data} />
            <StrongResistanceCard data={data} />
            <StrongSupportCard data={data} />
          </div>

          {/* CENTER — col-span-5: BestOptionBuy (full height) */}
          <div className="col-span-5 min-h-0">
            <BestOptionBuyCard data={data} />
          </div>

          {/* RIGHT — col-span-4: ShiftFlow + TrapRisk + Alternate */}
          <div className="col-span-4 grid min-h-0 grid-rows-[1fr_1fr_1.2fr] gap-1.5">
            <ShiftFlowCard data={data} />
            <TrapRiskCard data={data} />
            <AlternateScenarioCard data={data} />
          </div>
        </div>

        {/* Bottom row — 5 cards */}
        <div className="grid min-h-0 flex-[1.4] grid-cols-5 gap-1.5">
          <SmartMoneyFlowCard data={data} />
          <SRQuickViewCard data={data} />
          <TrendMomentumCard data={data} />
          <KeyLevelsCard data={data} />
          <ConfidenceMeterCard data={data} />
        </div>
      </div>
    </div>
  );
}
