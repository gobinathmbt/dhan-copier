import type { IntelV2Snapshot } from "@/lib/intelV2Types";
import { V2Card, V2_TONE } from "./common";
import { ShieldCheck, ShieldX, AlertTriangle } from "lucide-react";

const ICONS: Record<string, string> = {
  chopMarket:        "🌊",
  weakPremium:       "💧",
  weakDelta:         "📉",
  futuresDivergence: "↔",
  insideValue:       "🌫",
  ivCrush:           "💥",
  breadthWeak:       "📊",
  heavyweightsWeak:  "🏛",
};

export function Row5NoTradeEngine({ data }: { data: IntelV2Snapshot | null }) {
  const nt = data?.dashboard?.noTradeConditions;
  const tone = nt?.resultTone === "bull" ? "bull"
    : nt?.resultTone === "warn" ? "warn"
    : "bear";
  const result = nt?.result || "—";

  return (
    <div className="grid h-[140px] grid-cols-12 gap-2">
      <V2Card className="col-span-9" title="5 — Auto No-Trade Conditions">
        <div className="grid grid-cols-8 gap-1.5 px-1">
          {(nt?.conditions || []).map((c) => {
            const detected = !!c.detected;
            const cTone = detected ? "bear" : "bull";
            return (
              <div
                key={c.key}
                className="flex flex-col items-center justify-center rounded-md border px-1.5 py-2"
                style={{
                  borderColor: V2_TONE[cTone].border,
                  background: V2_TONE[cTone].soft,
                }}
              >
                <span className="text-[20px] leading-none">{ICONS[c.key] || "•"}</span>
                <span
                  className="mt-1.5 text-center text-[10px] font-bold uppercase leading-tight tracking-wider"
                  style={{ color: V2_TONE[cTone].color }}
                >
                  {c.label}
                </span>
                <span
                  className="mt-1 text-[10px] font-bold uppercase tracking-widest"
                  style={{ color: V2_TONE[cTone].color }}
                >
                  {detected ? "YES" : "NO"}
                </span>
              </div>
            );
          })}
        </div>
      </V2Card>

      <V2Card className="col-span-3" title="Result" accent={tone as "bull" | "bear" | "warn"}>
        <div className="flex h-full flex-col items-center justify-center">
          {result === "SAFE TO TRADE" ? (
            <ShieldCheck size={34} className="text-emerald-400" />
          ) : result === "CAUTION" ? (
            <AlertTriangle size={34} className="text-amber-400" />
          ) : (
            <ShieldX size={34} className="text-rose-400" />
          )}
          <span
            className="mt-1.5 text-[22px] font-black tracking-tight"
            style={{ color: V2_TONE[tone].color }}
          >
            {result}
          </span>
          <span className="text-[11px] text-white/55 text-center px-2 mt-1">
            {result === "SAFE TO TRADE"
              ? "High quality setup. Institutions aligned."
              : result === "CAUTION"
                ? "Mixed conditions. Reduce size."
                : "Wait for cleaner signals."}
          </span>
        </div>
      </V2Card>
    </div>
  );
}
