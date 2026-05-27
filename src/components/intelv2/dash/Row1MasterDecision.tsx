import type { IntelV2Snapshot } from "@/lib/intelV2Types";
import { V2_TONE, v2Tone } from "./common";
import { cn } from "@/lib/utils";
import {
  TrendingUp, Scale, LinkIcon, Activity, Flame,
  ShieldAlert, Target, Gauge,
} from "lucide-react";

const ICONS: Record<string, typeof TrendingUp> = {
  marketState: TrendingUp,
  smartMoney:  Scale,
  futures:     LinkIcon,
  premium:     Activity,
  delta:       Flame,
  trapRisk:    ShieldAlert,
  bestAction:  Target,
  confidence:  Gauge,
};

const ORDER: Array<keyof IntelV2Snapshot["dashboard"]["statusWidgets"]> = [
  "marketState", "smartMoney", "futures", "premium", "delta", "trapRisk", "bestAction", "confidence",
];

const HEADERS: Record<string, string> = {
  marketState: "MARKET REGIME",
  smartMoney:  "SMART MONEY BIAS",
  futures:     "FUTURES LEADERSHIP",
  premium:     "PREMIUM HEALTH",
  delta:       "DELTA AGGRESSION",
  trapRisk:    "TRAP RISK",
  bestAction:  "TRADE ACTION",
  confidence:  "CONFIDENCE SCORE",
};

export function Row1MasterDecision({ data }: { data: IntelV2Snapshot | null }) {
  const sw = data?.dashboard?.statusWidgets;

  return (
    <div className="grid h-[150px] grid-cols-8 gap-2">
      {ORDER.map((k) => {
        const w = sw?.[k] as { label?: string; tone?: string; sub?: string; score?: number; key?: string } | undefined;
        const Icon = ICONS[k] || TrendingUp;
        const isConf = k === "confidence";

        const tone = isConf
          ? ((w?.score ?? 0) >= 65 ? "bull" : (w?.score ?? 0) >= 50 ? "warn" : "bear")
          : v2Tone(w?.tone);
        const t = V2_TONE[tone];
        const heading = HEADERS[k];

        return (
          <div
            key={k}
            className="flex h-full flex-col rounded-md border bg-[#0e1117] p-3"
            style={{ borderColor: t.border }}
          >
            <div className="flex items-center gap-1.5">
              <Icon size={12} style={{ color: t.color }} />
              <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/65">
                {heading}
              </span>
            </div>

            <div className="mt-1 flex flex-1 items-center justify-between">
              {isConf ? (
                <ConfidenceRing score={w?.score ?? 0} tone={tone} />
              ) : (
                <div className="flex flex-col">
                  <span
                    className="font-mono text-[20px] font-black leading-tight"
                    style={{ color: t.color }}
                  >
                    {w?.label || "—"}
                  </span>
                  <span className="mt-1 text-[11px] text-white/55">
                    {w?.sub || ""}
                  </span>
                </div>
              )}
              {!isConf ? (
                <div
                  className="ml-2 hidden h-12 w-12 shrink-0 items-center justify-center rounded-full sm:flex"
                  style={{ background: t.soft }}
                >
                  <Icon size={20} style={{ color: t.color }} />
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ConfidenceRing({ score, tone }: { score: number; tone: keyof typeof V2_TONE }) {
  const t = V2_TONE[tone];
  const r = 24, c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score));
  const dash = (pct / 100) * c;
  return (
    <div className="flex w-full items-center justify-between">
      <div className="flex flex-col">
        <span className="text-[10px] uppercase tracking-wide text-white/55">Score</span>
        <span className="font-mono text-[12px] text-white/65">
          {pct >= 80 ? "High" : pct >= 65 ? "Strong" : pct >= 50 ? "Moderate" : "Low"}
        </span>
      </div>
      <svg width="62" height="62" viewBox="0 0 60 60" className="shrink-0">
        <circle cx="30" cy="30" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="5" />
        <circle
          cx="30" cy="30" r={r} fill="none"
          stroke={t.color} strokeWidth="5"
          strokeDasharray={`${dash} ${c}`}
          strokeLinecap="round"
          transform="rotate(-90 30 30)"
        />
        <text
          x="30" y="34" textAnchor="middle"
          className={cn("font-mono")}
          style={{ fill: t.color, fontSize: "14px", fontWeight: 800 }}
        >
          {Math.round(pct)}%
        </text>
      </svg>
    </div>
  );
}
