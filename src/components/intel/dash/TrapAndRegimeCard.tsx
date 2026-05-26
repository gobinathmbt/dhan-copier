import type { IntelSnapshot } from "@/lib/intelTypes";
import { Card, Pill } from "./common";

export function TrapDetectorCard({ data }: { data: IntelSnapshot | null }) {
  if (!data) return <Card title="Trap Detector">…</Card>;
  const rows = data.dashboard?.trapDetector || [];
  const trapTone = data.trap?.risk === "high" ? "bear" : data.trap?.risk === "medium" ? "warn" : "bull";

  return (
    <Card title="Trap Detector">
      <div className="flex h-full flex-col">
        <div className="flex-1 space-y-2 text-[11px]">
          {rows.map((r) => (
            <div
              key={r.key}
              className="flex items-center justify-between border-b border-white/[0.03] py-0.5 last:border-b-0"
            >
              <span className="text-white/65">{r.label}</span>
              {r.detected ? (
                <Pill label="YES" tone="bear" size="xs" />
              ) : (
                <Pill label="NO" tone="bull" size="xs" />
              )}
            </div>
          ))}
        </div>
        <div className="mt-1 flex items-center justify-between border-t border-white/[0.06] pt-1.5 text-[10px]">
          <span className="text-white/45">Trap Risk</span>
          <Pill label={(data.trap?.risk || "low").toUpperCase()} tone={trapTone as "bull" | "warn" | "bear"} />
        </div>
      </div>
    </Card>
  );
}

export function MarketRegimeCard({ data }: { data: IntelSnapshot | null }) {
  if (!data) return <Card title="Market Regime">…</Card>;
  const r = data.dashboard?.regimeClassification;
  if (!r) return <Card title="Market Regime">…</Card>;

  const dayTone = r.tone === "bull" ? "text-emerald-400"
    : r.tone === "bear" ? "text-rose-400"
    : r.tone === "warn" ? "text-amber-400"
    : "text-sky-400";

  return (
    <Card title="Market Regime">
      <div className="flex h-full flex-col">
        <div className="flex flex-1 flex-col items-center justify-center gap-1">
          <div className="text-[9px] uppercase tracking-wider text-white/40">Range · Trend · Volatile</div>
          <div className={`text-2xl font-bold tracking-wide ${dayTone}`}>{r.dayType}</div>
        </div>
        <div className="space-y-1 border-t border-white/[0.06] pt-2 text-[11px]">
          <Row label="Volatility" value={r.volatility} tone={r.volatility === "HIGH" ? "warn" : r.volatility === "LOW" ? "bull" : "info"} />
          <Row label="Trend Strength" value={r.trendStrength} tone={r.trendStrength === "STRONG" ? "bull" : r.trendStrength === "WEAK" ? "bear" : "info"} />
          <Row label="Market Quality" value={r.marketQuality} tone={r.marketQuality === "GOOD" ? "bull" : "info"} />
          <Row label="Participation" value={r.participation} tone={r.participation === "HIGH" ? "bull" : "warn"} />
        </div>
      </div>
    </Card>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone: "bull" | "bear" | "warn" | "info" }) {
  const map: Record<string, string> = {
    bull: "text-emerald-400",
    bear: "text-rose-400",
    warn: "text-amber-400",
    info: "text-sky-400",
  };
  return (
    <div className="flex items-center justify-between">
      <span className="text-white/55">{label}</span>
      <span className={`font-mono text-xs font-bold tracking-wider ${map[tone]}`}>{value}</span>
    </div>
  );
}
