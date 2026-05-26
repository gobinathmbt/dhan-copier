import type { IntelSnapshot } from "@/lib/intelTypes";
import { Card } from "./common";
import { useMemo } from "react";

export function FrvpCard({ data }: { data: IntelSnapshot | null }) {
  if (!data) return <Card title="FRVP (Volume Profile)">…</Card>;
  const v = data.flow?.volume;
  const histogram = data.dashboard?.frvpHistogram || [];
  const spot = data.spot.ltp;

  // Sort by price desc so highest price is at top of card (visual conventions)
  const bins = useMemo(() => {
    const sorted = [...histogram].sort((a, b) => b.price - a.price);
    const maxVol = Math.max(1, ...sorted.map((b) => b.volume));
    return sorted.map((b) => ({
      ...b,
      pct: (b.volume / maxVol) * 100,
    }));
  }, [histogram]);

  const aboveAcceptance = data.dashboard?.priceAbovePoc;

  return (
    <Card title="FRVP (Volume Profile)">
      <div className="grid h-full grid-cols-12 grid-rows-[auto_1fr_auto] gap-2 overflow-hidden">
        {/* Top stats */}
        <div className="col-span-12 grid grid-cols-3 gap-2 text-[10px]">
          <div>
            <div className="text-white/35">POC</div>
            <div className="font-mono text-sm font-bold text-amber-400">{v?.poc?.toFixed(0) || "—"}</div>
          </div>
          <div>
            <div className="text-white/35">VAH</div>
            <div className="font-mono text-sm font-bold text-sky-400">{v?.vah?.toFixed(0) || "—"}</div>
          </div>
          <div>
            <div className="text-white/35">VAL</div>
            <div className="font-mono text-sm font-bold text-sky-400">{v?.val?.toFixed(0) || "—"}</div>
          </div>
        </div>

        {/* Horizontal histogram */}
        <div className="col-span-12 min-h-0 overflow-y-auto">
          {bins.length ? (
            <div className="flex flex-col gap-0.5">
              {bins.map((b, i) => {
                const isPoc = v?.poc && Math.abs(b.price - v.poc) < 5;
                const isVah = v?.vah && Math.abs(b.price - v.vah) < 5;
                const isVal = v?.val && Math.abs(b.price - v.val) < 5;
                const isSpot = spot && Math.abs(b.price - spot) < 5;
                const color = (b.delta ?? 0) > 0 ? "#22c55e" : (b.delta ?? 0) < 0 ? "#ef4444" : "#64748b";
                return (
                  <div key={i} className="relative grid h-3 grid-cols-12 items-center gap-1">
                    <div
                      className="col-span-9 h-2 rounded-sm transition-all"
                      style={{ width: `${b.pct}%`, background: color, opacity: isPoc ? 1 : 0.7 }}
                    />
                    <div className={`col-span-3 text-right font-mono text-[8px] tabular-nums ${isSpot ? "text-amber-300 font-bold" : "text-white/55"}`}>
                      {b.price.toFixed(0)}
                    </div>
                    {isPoc ? (
                      <span className="absolute right-12 top-1/2 -translate-y-1/2 text-[7px] font-bold text-amber-300">POC</span>
                    ) : null}
                    {isVah ? (
                      <span className="absolute right-12 top-1/2 -translate-y-1/2 text-[7px] font-bold text-sky-300">VAH</span>
                    ) : null}
                    {isVal ? (
                      <span className="absolute right-12 top-1/2 -translate-y-1/2 text-[7px] font-bold text-sky-300">VAL</span>
                    ) : null}
                    {isSpot ? (
                      <span className="absolute -right-2 top-1/2 h-px w-12 -translate-y-1/2 bg-amber-400" />
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-[10px] text-white/25">
              insufficient candles for FRVP
            </div>
          )}
        </div>

        {/* Bottom acceptance line */}
        <div className="col-span-12 flex items-center justify-between border-t border-white/[0.04] pt-1.5 text-[10px]">
          <span className="text-white/40">
            Price {aboveAcceptance != null ? `${aboveAcceptance >= 50 ? "Above" : "Below"} POC` : ""}
          </span>
          <span className="font-mono font-bold text-emerald-400">
            {v?.acceptance === "above_va" ? "Bullish Acceptance"
              : v?.acceptance === "below_va" ? "Bearish Acceptance"
              : v?.acceptance === "inside_va" ? "Inside VA"
              : "—"}
          </span>
        </div>
      </div>
    </Card>
  );
}
