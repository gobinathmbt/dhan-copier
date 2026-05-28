import type { IntelV2Snapshot } from "@/lib/intelV2Types";
import { V2Card, V2_TONE, v2Fmt, v2FmtCompact, v2FmtSigned, v2FmtSignedCompact, V2Pill } from "./common";
import { TrendingUp, ShieldCheck, AlertTriangle } from "lucide-react";

/**
 * 2.3 OI Buildup Analysis — full institutional layout matching the
 * Sensibull / IIFL screenshot:
 *   • Top stats strip — Spot, Total CE OI, Total PE OI, PCR, Market View
 *   • Two side-by-side panels (CE / PE) each with:
 *       - Top-5 strikes table (Strike, OI Today, OI Yesterday, ΔOI, %Δ, Interpretation)
 *       - Bar chart of OI Change vs Yesterday with spot reference line
 *       - Key Takeaway footer
 */
export function OiBuildupAnalysisCard({ data }: { data: IntelV2Snapshot | null }) {
  const o = data?.dashboard?.oiBuildupAnalysis;

  if (!o) {
    return (
      <V2Card title="2.3 OI Buildup Analysis">
        <div className="flex h-full items-center justify-center text-[12px] text-white/45">
          No OI buildup data
        </div>
      </V2Card>
    );
  }

  const spotPrice = data?.spot?.ltp ?? o.spot.price;
  const spotChange = data?.spot?.change ?? 0;
  const spotChangePct = data?.spot?.changePct ?? 0;

  const viewTone = o.marketView.tone === "bull" ? "bull"
                : o.marketView.tone === "bear" ? "bear" : "warn";
  const viewColor = V2_TONE[viewTone].color;

  return (
    <V2Card title="2.3 OI Buildup Analysis">
      {/* ── Top stats strip ───────────────────────────────────────────── */}
      <div className="grid grid-cols-5 gap-2">
        <Stat label="Spot Price" value={v2Fmt(spotPrice, 2)} sub={`${spotChange >= 0 ? "+" : ""}${spotChange.toFixed(2)} (${spotChangePct >= 0 ? "+" : ""}${spotChangePct.toFixed(2)}%)`} subTone={spotChange >= 0 ? "bull" : "bear"} />
        <Stat label="Total CE OI" value={v2FmtCompact(o.totals.ce.today)} sub={`${o.totals.ce.change >= 0 ? "+" : ""}${v2FmtCompact(o.totals.ce.change)} (${o.totals.ce.changePct >= 0 ? "+" : ""}${o.totals.ce.changePct.toFixed(2)}%)`} subTone={o.totals.ce.change >= 0 ? "bear" : "bull"} valueColor={V2_TONE.bear.color} />
        <Stat label="Total PE OI" value={v2FmtCompact(o.totals.pe.today)} sub={`${o.totals.pe.change >= 0 ? "+" : ""}${v2FmtCompact(o.totals.pe.change)} (${o.totals.pe.changePct >= 0 ? "+" : ""}${o.totals.pe.changePct.toFixed(2)}%)`} subTone={o.totals.pe.change >= 0 ? "bull" : "bear"} valueColor={V2_TONE.bull.color} />
        <Stat label="PCR (CE/PE OI Ratio)" value={o.totals.pcr.toFixed(2)} sub={o.totals.pcr >= 1.05 ? "Bullish PCR" : o.totals.pcr <= 0.95 ? "Bearish PCR" : "Neutral"} subTone={o.totals.pcr >= 1.05 ? "bull" : o.totals.pcr <= 0.95 ? "bear" : "warn"} />
        <Stat
          label="Market View"
          value={o.marketView.label}
          valueColor={viewColor}
          icon={
            o.marketView.tone === "bull" ? <TrendingUp size={16} style={{ color: viewColor }} /> :
            o.marketView.tone === "bear" ? <TrendingUp size={16} style={{ color: viewColor, transform: "rotate(180deg)" }} /> :
            null
          }
          sub={`PCR ${o.marketView.ratio.toFixed(2)}`}
          subTone={viewTone}
        />
      </div>

      {/* ── Two-panel CE / PE block ───────────────────────────────────── */}
      <div className="mt-3 grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-hidden">
        <SidePanel
          side="CE"
          title="Call OI Buildup"
          chartTitle="CE OI Change (vs Yesterday)"
          accent="bull"
          rows={o.ceTable}
          chart={o.ceChart}
          spot={spotPrice}
          takeaway={o.ceTakeaway}
        />
        <SidePanel
          side="PE"
          title="Put OI Buildup"
          chartTitle="PE OI Change (vs Yesterday)"
          accent="bear"
          rows={o.peTable}
          chart={o.peChart}
          spot={spotPrice}
          takeaway={o.peTakeaway}
        />
      </div>
    </V2Card>
  );
}

// ── Top-strip stat ─────────────────────────────────────────────────────
function Stat({
  label, value, sub, subTone, valueColor, icon,
}: {
  label: string;
  value: string;
  sub?: string;
  subTone?: "bull" | "bear" | "warn" | "neutral";
  valueColor?: string;
  icon?: React.ReactNode;
}) {
  const subColor = subTone ? V2_TONE[subTone].color : "rgba(255,255,255,0.55)";
  return (
    <div className="flex flex-col items-center gap-0.5 rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-2">
      <span className="text-[10px] uppercase tracking-[0.12em] text-white/55">{label}</span>
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="font-mono text-[16px] font-bold tabular-nums" style={{ color: valueColor || "rgba(255,255,255,0.95)" }}>
          {value}
        </span>
      </div>
      {sub ? (
        <span className="font-mono text-[10px] tabular-nums" style={{ color: subColor }}>
          {sub}
        </span>
      ) : null}
    </div>
  );
}

// ── Side panel (CE or PE) — table + bar chart + takeaway ──────────────
type SideRow = NonNullable<IntelV2Snapshot["dashboard"]>["oiBuildupAnalysis"] extends infer T
  ? T extends { ceTable: infer R } ? (R extends Array<infer X> ? X : never) : never
  : never;
type ChartPoint = { strike: number; oiChange: number; isAtm: boolean };

function SidePanel({
  side, title, chartTitle, accent, rows, chart, spot, takeaway,
}: {
  side: "CE" | "PE";
  title: string;
  chartTitle: string;
  accent: "bull" | "bear";
  rows: SideRow[];
  chart: ChartPoint[];
  spot: number;
  takeaway: string;
}) {
  const accentColor = V2_TONE[accent].color;
  const accentSoft = V2_TONE[accent].soft;
  const accentBorder = V2_TONE[accent].border;

  // Interpret tone helper
  const interpTone = (t: string) => {
    const x = (t || "").toLowerCase();
    if (x.includes("strong buildup")) return "bull";
    if (x.includes("buildup"))         return "warn";
    if (x.includes("unwinding"))       return "bear";
    return "neutral";
  };

  return (
    <div
      className="flex min-h-0 flex-col gap-2 overflow-hidden rounded-md border bg-[#0a0d12] p-2"
      style={{ borderColor: accentBorder, background: accentSoft }}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <span
          className="rounded-sm px-2 py-0.5 text-[11px] font-bold tracking-widest"
          style={{ background: accentColor, color: "#000" }}
        >
          {side}
        </span>
        <span className="text-[12px] font-bold uppercase tracking-wider text-white/85">
          {title}
        </span>
      </div>

      {/* Table */}
      <div className="flex flex-col rounded-sm bg-black/30 px-1.5 py-1.5">
        <div className="grid grid-cols-[60px_60px_70px_60px_50px_1fr] items-center gap-1 border-b border-white/[0.05] px-1 pb-1 text-[9px] font-bold uppercase tracking-wider text-white/45">
          <span>Strike</span>
          <span className="text-right">Today</span>
          <span className="text-right">Yesterday</span>
          <span className="text-right">Δ OI</span>
          <span className="text-right">%Δ</span>
          <span className="pl-1">Interpretation</span>
        </div>
        <div className="flex flex-col">
          {rows.map((r) => {
            const tone = interpTone(r.interpretation);
            const interpColor = V2_TONE[tone].color;
            return (
              <div
                key={r.strike}
                className="grid grid-cols-[60px_60px_70px_60px_50px_1fr] items-center gap-1 border-b border-white/[0.03] px-1 py-1 text-[11px] last:border-b-0"
                style={{ background: r.isAtm ? "rgba(59,130,246,0.10)" : "transparent" }}
              >
                <span className="font-mono font-bold" style={{ color: r.isAtm ? "#7dd3fc" : "rgba(255,255,255,0.92)" }}>
                  {r.strike}{r.isAtm ? <span className="ml-1 text-[8px] text-sky-300">ATM</span> : null}
                </span>
                <span className="text-right font-mono tabular-nums text-white/85">{v2FmtCompact(r.oiToday)}</span>
                <span className="text-right font-mono tabular-nums text-white/65">{v2FmtCompact(r.oiPrev)}</span>
                <span className="text-right font-mono tabular-nums" style={{ color: r.oiChange >= 0 ? accentColor : V2_TONE.warn.color }}>
                  {r.oiChange >= 0 ? "+" : ""}{v2FmtCompact(r.oiChange)}
                </span>
                <span className="text-right font-mono tabular-nums" style={{ color: r.oiChangePct >= 0 ? accentColor : V2_TONE.warn.color }}>
                  {r.oiChangePct >= 0 ? "+" : ""}{r.oiChangePct.toFixed(2)}%
                </span>
                <span className="pl-1 text-[10px] font-bold" style={{ color: interpColor }}>
                  {r.interpretation}
                </span>
              </div>
            );
          })}
          {!rows.length ? (
            <div className="px-2 py-3 text-center text-[11px] text-white/45">No buildup data</div>
          ) : null}
        </div>
      </div>

      {/* Bar chart */}
      <div className="flex flex-col rounded-sm bg-black/30 p-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] font-bold" style={{ color: accentColor }}>
            {chartTitle}
          </span>
          <span className="text-[10px] text-white/55">
            Spot Price <span className="font-mono font-bold text-white/85">{v2Fmt(spot, 2)}</span>
          </span>
        </div>
        <BarChart points={chart} accent={accent} spot={spot} />
      </div>

      {/* Key takeaway */}
      <div
        className="flex items-start gap-2 rounded-sm border px-2.5 py-2"
        style={{ borderColor: accentBorder, background: "rgba(0,0,0,0.35)" }}
      >
        {accent === "bull"
          ? <ShieldCheck size={14} style={{ color: accentColor }} className="mt-0.5 shrink-0" />
          : <AlertTriangle size={14} style={{ color: accentColor }} className="mt-0.5 shrink-0" />}
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: accentColor }}>
            Key Takeaway ({side})
          </span>
          <span className="text-[11px] leading-tight text-white/85">{takeaway}</span>
        </div>
      </div>
    </div>
  );
}

// ── Bar chart — vertical bars, signed, with spot reference line ───────
function BarChart({
  points, accent, spot,
}: {
  points: ChartPoint[];
  accent: "bull" | "bear";
  spot: number;
}) {
  if (!points.length) {
    return (
      <div className="flex h-28 items-center justify-center text-[11px] text-white/45">
        No data
      </div>
    );
  }
  const accentColor = V2_TONE[accent].color;
  const dimColor = "rgba(239,68,68,0.55)";  // red dim for negatives (CE side)
  const dimColorPos = "rgba(34,197,94,0.45)";

  // Y-axis range — symmetric around 0 for readability
  const maxAbs = Math.max(1, ...points.map(p => Math.abs(p.oiChange)));

  // Find the strike index nearest spot for the dashed reference line
  const sortedByDist = [...points].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
  const spotStrike = sortedByDist[0]?.strike;

  const barW = 100 / points.length;
  return (
    <div className="relative h-32 w-full">
      {/* Zero line */}
      <div className="absolute left-0 right-0 top-1/2 h-px bg-white/15" />
      {/* Spot dashed line */}
      {Number.isFinite(spotStrike) ? (
        <div
          className="absolute top-0 h-full"
          style={{
            left: `${(points.findIndex(p => p.strike === spotStrike) + 0.5) * barW}%`,
            borderLeft: "1.5px dashed rgba(255,255,255,0.35)",
          }}
        />
      ) : null}

      {/* Bars */}
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
      >
        {points.map((p, i) => {
          const h = (Math.abs(p.oiChange) / maxAbs) * 48; // 48% = half height
          const x = i * barW + barW * 0.15;
          const w = barW * 0.7;
          const y = p.oiChange >= 0 ? 50 - h : 50;
          const fill = p.oiChange >= 0 ? accentColor : (accent === "bull" ? dimColor : dimColorPos);
          return (
            <g key={p.strike}>
              <rect x={x} y={y} width={w} height={h} fill={fill} opacity={p.isAtm ? 1 : 0.8} />
            </g>
          );
        })}
      </svg>

      {/* Value labels */}
      <div className="absolute inset-0 flex">
        {points.map((p, i) => {
          const isPos = p.oiChange >= 0;
          return (
            <div
              key={p.strike}
              className="relative flex flex-1 flex-col items-center justify-end"
            >
              <span
                className="absolute font-mono text-[9px] tabular-nums"
                style={{
                  bottom: isPos ? `calc(50% + ${(Math.abs(p.oiChange) / maxAbs) * 48}% + 2px)` : `calc(50% - ${(Math.abs(p.oiChange) / maxAbs) * 48}% - 12px)`,
                  color: isPos ? V2_TONE[accent].color : V2_TONE.warn.color,
                }}
              >
                {Math.abs(p.oiChange) >= 1e3
                  ? `${isPos ? "+" : "-"}${v2FmtCompact(Math.abs(p.oiChange))}`
                  : ""}
              </span>
            </div>
          );
        })}
      </div>

      {/* X-axis labels */}
      <div className="absolute -bottom-4 left-0 right-0 flex">
        {points.map((p) => (
          <div
            key={`x-${p.strike}`}
            className="flex-1 text-center font-mono text-[9px] tabular-nums text-white/55"
          >
            {p.strike}
          </div>
        ))}
      </div>
    </div>
  );
}
