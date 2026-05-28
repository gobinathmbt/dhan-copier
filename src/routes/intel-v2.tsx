import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { isAuthenticated } from "@/lib/auth";
import { useIntelV2Snapshot, fetchAvailableDates } from "@/hooks/useIntelV2Snapshot";
import type { IntelV2Symbol } from "@/lib/intelV2Types";

import { TopHeaderV2 } from "@/components/intelv2/dash/TopHeader";
import { Row1MasterDecision } from "@/components/intelv2/dash/Row1MasterDecision";
import { Row1bTradeBoard } from "@/components/intelv2/dash/Row1bTradeBoard";
import { HeroZeroCard } from "@/components/intelv2/dash/HeroZeroCard";
import { PremiumMomentumCard } from "@/components/intelv2/dash/PremiumMomentumCard";
import { TradeStrategyCard } from "@/components/intelv2/dash/TradeStrategyCard";
import { MarketStoryCard } from "@/components/intelv2/dash/MarketStoryCard";
import { Row2InstitutionalFlow } from "@/components/intelv2/dash/Row2InstitutionalFlow";
import { Row3ConfirmationLayer } from "@/components/intelv2/dash/Row3ConfirmationLayer";
import { Row4StructureContext } from "@/components/intelv2/dash/Row4StructureContext";
import { Row5NoTradeEngine } from "@/components/intelv2/dash/Row5NoTradeEngine";
// Hidden: Row6 + Row7 are still imported for tree-shaking parity but not rendered.
// import { Row6BottomPanel } from "@/components/intelv2/dash/Row6BottomPanel";
// import { Row7AuctionPanel } from "@/components/intelv2/dash/Row7AuctionPanel";
import { AlertsTickerV2 } from "@/components/intelv2/dash/AlertsTicker";

export const Route = createFileRoute("/intel-v2")({
  component: IntelV2Page,
});

function IntelV2Page() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!isAuthenticated()) navigate({ to: "/login" });
  }, [navigate]);

  const [symbol, setSymbol] = useState<IntelV2Symbol>("NIFTY_50");
  const [date, setDate]     = useState<string | null>(null);
  const [availableDates, setAvailableDates] = useState<string[]>([]);

  const { data, loading, refetch, lastFetchAt } = useIntelV2Snapshot({
    symbol,
    date,
    intervalMs: 3000,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ds = await fetchAvailableDates(symbol);
      if (!cancelled) setAvailableDates(ds);
    })();
    return () => { cancelled = true; };
  }, [symbol]);

  return (
    <div className="fixed inset-0 left-16 flex flex-col bg-[#070a0e] text-white">
      <TopHeaderV2
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

      <main className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-2.5">
        <Row1MasterDecision data={data} />
        {/* Hero/Zero (40%) + Premium Momentum (30%) + Trade Strategy (30%) */}
        <div className="grid h-[260px] grid-cols-10 gap-2">
          <div className="col-span-4 min-h-0"><HeroZeroCard data={data} /></div>
          <div className="col-span-3 min-h-0"><PremiumMomentumCard data={data} /></div>
          <div className="col-span-3 min-h-0"><TradeStrategyCard data={data} /></div>
        </div>
        <Row1bTradeBoard data={data} />
        <Row2InstitutionalFlow data={data} />
        <Row3ConfirmationLayer data={data} />
        <Row4StructureContext data={data} />
        <Row5NoTradeEngine data={data} />
        <div className="min-h-[280px]"><MarketStoryCard data={data} /></div>
        {/* Sections below Row 5 are commented out per dashboard simplification.
            Auction panel + bottom panel remain implemented but hidden. */}
        {/* <Row7AuctionPanel data={data} /> */}
        {/* <Row6BottomPanel data={data} /> */}
      </main>

      <AlertsTickerV2 data={data} />
    </div>
  );
}
