import type { IntelV2Snapshot } from "@/lib/intelV2Types";
import { V2Card, V2_TONE } from "./common";

/**
 * OPTION BUYER ENGINE (V2 institutional upgrades)
 * ========================================================================
 * One card, six professional option-buyer reads — answers "is this move
 * actually worth chasing?" rather than just "is the market bullish?".
 *
 *   • Buyer Quality Score (0-100) — headline action
 *   • Premium Efficiency          — is premium responding to the move?
 *   • Delta Persistence           — sustained buying or a spike?
 *   • Strike Migration            — are institutions shifting walls?
 *   • Premium Trap Probability    — move not backed by premium?
 *   • Wall Break Probability      — resistance/support breakability
 *
 * Sources: data.dashboard.{optionBuyerQuality, premiumEfficiency,
 * deltaPersistence, strikeMigration, premiumTrap, wallBreak}.
 */
export function OptionBuyerEngineCard({ data }: { data: IntelV2Snapshot | null }) {
  const d = data?.dashboard;
  const q = d?.optionBuyerQuality;
  const eff = d?.premiumEfficiency;
  const dp = d?.deltaPersistence;
  const mig = d?.strikeMigration;
  const trap = d?.premiumTrap;
  const wall = d?.wallBreak;

  if (!q) {
    return (
      <V2Card title="🎯 Option Buyer Engine">
        <div className="flex h-full items-center justify-center text-[12px] text-white/40">
          Awaiting tick data…
        </div>
      </V2Card>
    );
  }

  const qt = V2_TONE[q.tone];

  return (
    <V2Card
      title={
        <span className="flex items-center gap-2"><span>🎯</span>Option Buyer Engine</span>
      }
      accent={q.tone}
    >
      <div className="-m-1.5 flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden p-1.5">
        {/* Headline — Buyer Quality Score */}
        <div className="flex items-center gap-3 rounded-md border px-3 py-1.5"
          style={{ background: qt.soft, borderColor: qt.border }}>
          <div className="flex flex-col items-center">
            <span className="font-mono text-[26px] font-black leading-none" style={{ color: qt.color }}>{q.score}</span>
            <span className="text-[8px] font-bold uppercase tracking-wide text-white/45">/ 100</span>
          </div>
          <div className="flex flex-1 flex-col">
            <span className="text-[15px] font-black uppercase tracking-wide" style={{ color: qt.color }}>
              {q.action}{q.side !== "NEUTRAL" ? ` · ${q.side}` : ""}
            </span>
            <span className="text-[9px] leading-tight text-white/60">{q.interpretation}</span>
          </div>
        </div>

        {/* Premium Efficiency + Premium Trap */}
        <div className="grid grid-cols-2 gap-1.5">
          <MiniStat
            label="Premium Efficiency"
            value={eff?.ready && eff.score != null ? `${eff.score}%` : (eff?.label || "—")}
            sub={eff?.label && eff.label !== "WARMING UP" ? eff.label : (eff?.interpretation || "")}
            tone={eff?.tone || "neutral"}
          />
          <MiniStat
            label="Premium Trap Risk"
            value={trap?.level || "—"}
            sub={trap ? `${trap.probability}%` : ""}
            tone={trap?.tone || "neutral"}
          />
        </div>

        {/* Delta Persistence + sparkline */}
        <PersistenceRow dp={dp} />

        {/* Strike Migration */}
        <MigrationRow mig={mig} />

        {/* Wall Break Probability */}
        <div className="grid grid-cols-2 gap-1.5">
          <WallStat label="Resistance" wall={wall?.resistance} />
          <WallStat label="Support" wall={wall?.support} />
        </div>
      </div>
    </V2Card>
  );
}

function MiniStat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: keyof typeof V2_TONE }) {
  const t = V2_TONE[tone];
  return (
    <div className="flex flex-col rounded-md border px-2 py-1" style={{ background: t.soft, borderColor: t.border }}>
      <span className="text-[8px] font-bold uppercase tracking-[0.14em] text-white/55">{label}</span>
      <span className="font-mono text-[16px] font-black leading-none" style={{ color: t.color }}>{value}</span>
      {sub ? <span className="mt-0.5 text-[8px] leading-tight text-white/55">{sub}</span> : null}
    </div>
  );
}

function PersistenceRow({ dp }: { dp?: IntelV2Snapshot["dashboard"]["deltaPersistence"] }) {
  const tone = (dp?.tone || "neutral") as keyof typeof V2_TONE;
  const t = V2_TONE[tone];
  const series = dp?.series || [];
  const w = 90, h = 22;
  const min = Math.min(...series, -5, 0);
  const max = Math.max(...series, 5, 1);
  const range = Math.max(0.01, max - min);
  const pts = series.length
    ? series.map((v, i) => {
        const x = (i / (series.length - 1 || 1)) * w;
        const y = h - ((v - min) / range) * h;
        return `${x},${y}`;
      }).join(" ")
    : "";
  return (
    <div className="flex items-center gap-2 rounded-md border px-2 py-1" style={{ background: t.soft, borderColor: t.border }}>
      <div className="flex flex-col">
        <span className="text-[8px] font-bold uppercase tracking-[0.14em] text-white/55">Delta Persistence</span>
        <span className="text-[13px] font-black uppercase leading-none" style={{ color: t.color }}>{dp?.state || "—"}</span>
        <span className="text-[8px] text-white/55">{dp?.ready ? `${dp.sameSignPct}% same-side · avg ${dp.avg >= 0 ? "+" : ""}${dp.avg}` : "warming up"}</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="ml-auto h-5 w-[90px]" preserveAspectRatio="none">
        {/* zero line */}
        <line x1="0" x2={w} y1={h - ((0 - min) / range) * h} y2={h - ((0 - min) / range) * h} stroke="rgba(255,255,255,0.15)" strokeWidth="0.5" />
        <polyline points={pts} fill="none" stroke={t.color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function MigrationRow({ mig }: { mig?: IntelV2Snapshot["dashboard"]["strikeMigration"] }) {
  const tone = (mig?.tone || "neutral") as keyof typeof V2_TONE;
  const t = V2_TONE[tone];
  const arrow = (tr?: string) => tr === "RISING" ? "↑" : tr === "FALLING" ? "↓" : "→";
  return (
    <div className="flex items-center gap-2 rounded-md border px-2 py-1" style={{ background: t.soft, borderColor: t.border }}>
      <div className="flex flex-col">
        <span className="text-[8px] font-bold uppercase tracking-[0.14em] text-white/55">Strike Migration</span>
        <span className="text-[12px] font-black uppercase leading-tight" style={{ color: t.color }}>
          CE {mig?.callWall || "—"} {arrow(mig?.ceWallTrend)} · PE {mig?.putWall || "—"} {arrow(mig?.peWallTrend)}
        </span>
        <span className="text-[8px] leading-tight text-white/55">{mig?.interpretation || "warming up"}</span>
      </div>
    </div>
  );
}

function WallStat({ label, wall }: { label: string; wall?: { strike: number; strength: number; breakProbability: number; tone: string } | null }) {
  const tone = (wall?.tone || "neutral") as keyof typeof V2_TONE;
  const t = V2_TONE[tone];
  return (
    <div className="flex flex-col rounded-md border px-2 py-1" style={{ background: t.soft, borderColor: t.border }}>
      <span className="text-[8px] font-bold uppercase tracking-[0.14em] text-white/55">{label} {wall?.strike ? `· ${wall.strike}` : ""}</span>
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[12px] font-black" style={{ color: t.color }}>Str {wall ? `${wall.strength}%` : "—"}</span>
        <span className="font-mono text-[12px] font-black text-white/70">Brk {wall ? `${wall.breakProbability}%` : "—"}</span>
      </div>
    </div>
  );
}
