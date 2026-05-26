import type { IntelSnapshot } from "@/lib/intelTypes";
import { Bell, ShieldCheck, TrendingUp, TrendingDown, Activity, BarChart3, Zap, Target, Award, AlertTriangle } from "lucide-react";
import { TONE, toneOf } from "./common";
import { cn } from "@/lib/utils";

const ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
  "MARKET STATE": TrendingUp,
  "SMART MONEY": Activity,
  "FUTURES": Award,
  "OI STRUCTURE": BarChart3,
  "DELTA": Zap,
  "VWAP": TrendingDown,
  "TRAP RISK": AlertTriangle,
  "BEST ACTION": Target,
};

export function StatusStrip({ data }: { data: IntelSnapshot | null }) {
  const sw = data?.dashboard?.statusWidgets;
  if (!sw) {
    return (
    <div className="grid shrink-0 grid-cols-9 gap-2 px-3 py-2">
      {Array.from({ length: 9 }).map((_, i) => (
        <div key={i} className="h-14 animate-pulse rounded bg-white/[0.04]" />
      ))}
    </div>
  );
  }

  const tiles: Array<{
    key: string;
    label: string;
    tone: string;
    sub: string;
  }> = [
    { key: sw.marketState.key, label: sw.marketState.label, tone: sw.marketState.tone, sub: sw.marketState.sub },
    { key: sw.smartMoney.key, label: sw.smartMoney.label, tone: sw.smartMoney.tone, sub: sw.smartMoney.sub },
    { key: sw.futures.key, label: sw.futures.label, tone: sw.futures.tone, sub: sw.futures.sub },
    { key: sw.oiStructure.key, label: sw.oiStructure.label, tone: sw.oiStructure.tone, sub: sw.oiStructure.sub },
    { key: sw.delta.key, label: sw.delta.label, tone: sw.delta.tone, sub: sw.delta.sub },
    { key: sw.vwap.key, label: sw.vwap.label, tone: sw.vwap.tone, sub: sw.vwap.sub },
    { key: sw.trapRisk.key, label: sw.trapRisk.label, tone: sw.trapRisk.tone, sub: sw.trapRisk.sub },
    { key: sw.bestAction.key, label: sw.bestAction.label, tone: sw.bestAction.tone, sub: sw.bestAction.sub },
  ];

  return (
    <div className="grid shrink-0 grid-cols-9 gap-2">
      {tiles.map((t) => {
        const Icon = ICONS[t.key] || Activity;
        const tone = TONE[toneOf(t.tone)];
        return (
          <div
            key={t.key}
            className="flex flex-col gap-0.5 rounded-md border bg-[#11141a] px-2.5 py-1.5"
            style={{ borderColor: tone.border }}
          >
            <div className="flex items-center justify-between text-[8px] font-bold uppercase tracking-[0.14em] text-white/45">
              <span className="flex items-center gap-1">
                <Icon size={9} />
                {t.key}
              </span>
            </div>
            <div className="flex items-center gap-1 text-sm font-bold leading-tight" style={{ color: tone.color }}>
              {t.label}
              {t.tone === "bull" ? <TrendingUp size={11} /> : t.tone === "bear" ? <TrendingDown size={11} /> : null}
            </div>
            <div className="text-[10px] text-white/45">{t.sub}</div>
          </div>
        );
      })}

      {/* Confidence Score gauge */}
      <ConfidenceGauge score={sw.confidence.score} label={sw.confidence.label} />
    </div>
  );
}

function ConfidenceGauge({ score, label }: { score: number; label: string }) {
  const pct = Math.max(0, Math.min(100, score));
  // Half-circle gauge: 180deg sweep
  const angle = -90 + (pct / 100) * 180; // -90..+90
  const color = pct >= 80 ? "#22c55e" : pct >= 65 ? "#84cc16" : pct >= 50 ? "#eab308" : "#ef4444";

  // SVG path for half-circle progress
  const radius = 32;
  const cx = 40;
  const cy = 40;
  // Convert angle from -90..+90 to radians
  const angleRad = ((angle + 90) / 180) * Math.PI; // 0..pi
  const arcLen = (pct / 100) * Math.PI * radius;
  const circumference = Math.PI * radius;

  return (
    <div className="flex flex-col items-center justify-center rounded-md border border-white/[0.07] bg-[#11141a] px-2 py-2">
      <div className="text-[8px] font-bold uppercase tracking-[0.14em] text-white/45">CONFIDENCE SCORE</div>
      <div className="relative">
        <svg width="80" height="48" viewBox="0 0 80 48">
          {/* Background arc */}
          <path
            d={`M ${cx - radius} ${cy} A ${radius} ${radius} 0 0 1 ${cx + radius} ${cy}`}
            fill="none"
            stroke="rgba(255,255,255,0.08)"
            strokeWidth="6"
          />
          {/* Progress arc */}
          <path
            d={`M ${cx - radius} ${cy} A ${radius} ${radius} 0 0 1 ${cx + radius} ${cy}`}
            fill="none"
            stroke={color}
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={`${arcLen} ${circumference}`}
            style={{ filter: `drop-shadow(0 0 4px ${color})` }}
          />
          <text
            x={cx}
            y={cy - 4}
            textAnchor="middle"
            fill={color}
            style={{ font: "bold 16px monospace" }}
          >
            {pct}
          </text>
          <text x={cx} y={cy + 7} textAnchor="middle" fill="rgba(255,255,255,0.45)" style={{ font: "8px monospace" }}>
            /100
          </text>
        </svg>
      </div>
      <div className="text-[10px] text-white/55">{label}</div>
    </div>
  );
}
