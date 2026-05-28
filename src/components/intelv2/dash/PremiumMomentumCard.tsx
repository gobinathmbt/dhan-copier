import type { IntelV2Snapshot } from "@/lib/intelV2Types";
import { V2Card, V2_TONE } from "./common";

/**
 * PREMIUM MOMENTUM ENGINE
 * ========================================================================
 * 3 stat tiles (CE expansion · PE expansion · Momentum quality bars) +
 * 2 footer chips (Delta speed · Scalping aggression).
 *
 * Sources: data.dashboard.premiumMomentum (computed from FRVP engine +
 * delta + writer pressure + volatility regime).
 */
export function PremiumMomentumCard({ data }: { data: IntelV2Snapshot | null }) {
  const m = data?.dashboard?.premiumMomentum;
  if (!m) {
    return (
      <V2Card title="📈 Premium Momentum Engine">
        <div className="flex h-full items-center justify-center text-[12px] text-white/40">
          Awaiting tick data…
        </div>
      </V2Card>
    );
  }
  const topT = V2_TONE[m.topTone];

  return (
    <V2Card
      title={
        <span className="flex items-center gap-2">
          <span>📈</span>
          Premium Momentum Engine
        </span>
      }
      accent={m.topTone}
    >
      <div className="-m-1.5 flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden p-1.5">
        {/* Top headline state */}
        <div
          className="flex items-center justify-center gap-2 rounded-md border px-2 py-1"
          style={{ background: topT.soft, borderColor: topT.border }}
        >
          <span className="text-[14px]">{m.topLabel}</span>
          <span className="text-[12px] font-bold uppercase tracking-[0.16em]" style={{ color: topT.color }}>
            {m.topState}
          </span>
        </div>

        {/* 3-tile main row */}
        <div className="grid grid-cols-3 gap-1.5">
          <ExpansionTile
            label="CE Premium Expansion"
            value={m.ceExpansionPct}
            spark={m.ceSpark}
            tone="bull"
            ltp={m.ceLtp}
          />
          <ExpansionTile
            label="PE Premium Expansion"
            value={m.peExpansionPct}
            spark={m.peSpark}
            tone="bear"
            ltp={m.peLtp}
          />
          <QualityTile
            label="Momentum Quality"
            value={m.momentumQuality}
            score={m.momentumScore}
            tone={m.momentumTone}
          />
        </div>

        {/* Footer chips */}
        <div className="grid grid-cols-2 gap-1.5">
          <FooterChip
            label="Delta Speed"
            value={m.deltaSpeed}
            sub={`${m.deltaPct >= 0 ? "+" : ""}${m.deltaPct.toFixed(1)}%`}
            tone={m.deltaTone}
          />
          <FooterChip
            label="Scalping Aggression"
            value={m.scalpingAggression}
            sub={m.volSurge ? "Volume Surge ✓" : `Score ${m.scalpingScore}`}
            tone={m.scalpingTone}
          />
        </div>
      </div>
    </V2Card>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * Premium expansion tile — % + sparkline
 * ───────────────────────────────────────────────────────────────────── */
function ExpansionTile({
  label, value, spark, tone, ltp,
}: {
  label: string;
  value: number;
  spark: number[];
  tone: "bull" | "bear";
  ltp: number;
}) {
  const t = V2_TONE[tone];
  const isPositive = value >= 0;
  const valueColor = isPositive ? t.color : "rgba(255,255,255,0.55)";

  // Sparkline normalisation
  const min = Math.min(...spark, 0);
  const max = Math.max(...spark, 1);
  const range = Math.max(0.01, max - min);
  const w = 80;
  const h = 28;
  const points = spark.length
    ? spark.map((v, i) => {
        const x = (i / (spark.length - 1 || 1)) * w;
        const y = h - ((v - min) / range) * h;
        return `${x},${y}`;
      }).join(" ")
    : "";

  return (
    <div
      className="flex flex-col rounded-md border px-2 py-1"
      style={{ background: t.soft, borderColor: t.border }}
    >
      <span className="text-[8px] font-bold uppercase tracking-[0.14em] text-white/55">
        {label}
      </span>
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[20px] font-black leading-none" style={{ color: valueColor }}>
          {isPositive ? "+" : ""}{value}%
        </span>
        <span className="font-mono text-[9px] text-white/55">₹{ltp.toFixed(0)}</span>
      </div>
      {/* Sparkline */}
      <svg viewBox={`0 0 ${w} ${h}`} className="mt-0.5 h-7 w-full" preserveAspectRatio="none">
        <polyline
          points={points}
          fill="none"
          stroke={t.color}
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.85"
        />
      </svg>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * Momentum Quality tile — STRONG / MODERATE / WEAK + ascending bars
 * ───────────────────────────────────────────────────────────────────── */
function QualityTile({
  label, value, score, tone,
}: {
  label: string;
  value: string;
  score: number;
  tone: "bull" | "bear" | "warn" | "neutral";
}) {
  const t = V2_TONE[tone];
  // 7 ascending bars. Filled count proportional to score (0-100).
  const filled = Math.round((Math.min(100, Math.max(0, score)) / 100) * 7);
  return (
    <div
      className="flex flex-col rounded-md border px-2 py-1"
      style={{ background: t.soft, borderColor: t.border }}
    >
      <span className="text-[8px] font-bold uppercase tracking-[0.14em] text-white/55">
        {label}
      </span>
      <span className="font-mono text-[20px] font-black leading-none" style={{ color: t.color }}>
        {value}
      </span>
      {/* Ascending bar chart */}
      <span className="mt-0.5 flex h-7 items-end gap-[3px]">
        {Array.from({ length: 7 }).map((_, i) => {
          const heightPct = ((i + 1) / 7) * 100;
          return (
            <span
              key={i}
              className="w-2 rounded-[1px]"
              style={{
                height: `${heightPct}%`,
                background: i < filled ? t.color : "rgba(255,255,255,0.12)",
                opacity: i < filled ? 0.8 + (i / 7) * 0.2 : 1,
              }}
            />
          );
        })}
      </span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * Footer chip — Delta Speed / Scalping Aggression
 * ───────────────────────────────────────────────────────────────────── */
function FooterChip({
  label, value, sub, tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "bull" | "bear" | "warn" | "neutral";
}) {
  const t = V2_TONE[tone];
  return (
    <div
      className="flex items-center justify-between rounded-md border px-2.5 py-1"
      style={{ background: t.soft, borderColor: t.border }}
    >
      <span className="text-[9px] font-bold uppercase tracking-[0.16em] text-white/55">
        {label}
      </span>
      <span className="flex flex-col items-end">
        <span className="font-mono text-[13px] font-black leading-none" style={{ color: t.color }}>
          {value}
        </span>
        <span className="text-[9px] text-white/55">{sub}</span>
      </span>
    </div>
  );
}
