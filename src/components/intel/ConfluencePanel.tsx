import type { IntelSnapshot } from "@/lib/intelTypes";
import { Panel } from "./Panel";
import { cn } from "@/lib/utils";

function fmt(n: number | null | undefined, d = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

function Verdict({ label, verdict, hint }: { label: string; verdict: "bull" | "bear" | "neutral"; hint?: string }) {
  const map = {
    bull: { bg: "rgba(16,185,129,0.15)", color: "#10b981", text: "BULL" },
    bear: { bg: "rgba(239,68,68,0.15)", color: "#ef4444", text: "BEAR" },
    neutral: { bg: "rgba(107,114,128,0.15)", color: "#9ca3af", text: "—" },
  } as const;
  const m = map[verdict];
  return (
    <span
      className="inline-flex items-center justify-center rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wider"
      style={{ background: m.bg, color: m.color }}
      title={hint}
    >
      {m.text}
    </span>
  );
}

function Row({
  label,
  value,
  spot,
  verdict,
  hint,
}: {
  label: string;
  value: number | null | undefined;
  spot: number;
  verdict: "bull" | "bear" | "neutral";
  hint?: string;
}) {
  const v = Number(value);
  const dist = Number.isFinite(v) && spot ? v - spot : null;
  const distStr = dist == null ? "—" : `${dist >= 0 ? "+" : ""}${dist.toFixed(1)}`;
  const distColor = dist == null ? "text-white/30" : dist > 0 ? "text-emerald-400" : "text-rose-400";

  return (
    <div className="grid grid-cols-12 items-center gap-2 border-b border-white/[0.04] py-1.5 text-xs last:border-b-0">
      <span className="col-span-4 text-[10px] uppercase tracking-wider text-white/45" title={hint}>
        {label}
      </span>
      <span className="col-span-4 font-mono tabular-nums text-white/85">{fmt(value, 2)}</span>
      <span className={cn("col-span-2 text-right font-mono text-[10px] tabular-nums", distColor)}>
        {distStr}
      </span>
      <span className="col-span-2 text-right">
        <Verdict label={label} verdict={verdict} hint={hint} />
      </span>
    </div>
  );
}

export function ConfluencePanel({ data }: { data: IntelSnapshot | null }) {
  if (!data) {
    return (
      <Panel title="Trend Confluence" className="h-full">
        <div className="flex h-full items-center justify-center text-xs text-white/30">
          loading…
        </div>
      </Panel>
    );
  }

  const spot = data.spot.ltp;

  // Verdict per level: bull if spot above level (acting as support), else bear.
  const verdictAbove = (level: number | null | undefined): "bull" | "bear" | "neutral" => {
    const v = Number(level);
    if (!Number.isFinite(v) || v <= 0) return "neutral";
    return spot > v ? "bull" : "bear";
  };

  // CPR position verdict
  const cpr = data.cpr;
  let cprVerdict: "bull" | "bear" | "neutral" = "neutral";
  let cprPosition = "inside CPR";
  if (cpr) {
    if (spot > cpr.tc) { cprVerdict = "bull"; cprPosition = "above CPR"; }
    else if (spot < cpr.bc) { cprVerdict = "bear"; cprPosition = "below CPR"; }
    else { cprVerdict = "neutral"; cprPosition = "inside CPR"; }
  }

  // EMA stack verdict
  const { ema9, ema20, ema50 } = data.spot;
  let emaVerdict: "bull" | "bear" | "neutral" = "neutral";
  let emaText = "mixed";
  if (ema9 > ema20 && ema20 > ema50) { emaVerdict = "bull"; emaText = "9>20>50 bull stack"; }
  else if (ema9 < ema20 && ema20 < ema50) { emaVerdict = "bear"; emaText = "9<20<50 bear stack"; }

  return (
    <Panel
      title="Trend Confluence"
      badge={
        <span className="font-mono text-[10px] text-white/40">
          {fmt(spot, 2)} · {data.spot.changePct >= 0 ? "+" : ""}
          {fmt(data.spot.changePct, 2)}%
        </span>
      }
      className="h-full"
      scroll
    >
      <div className="space-y-2">
        {/* Quick summary chips */}
        <div className="grid grid-cols-3 gap-1.5">
          <div className="rounded border border-white/[0.06] bg-black/25 px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-white/40">CPR</div>
            <div className="text-xs font-bold text-white/85">{cprPosition}</div>
            {cpr ? <div className="text-[9px] text-white/45">{cpr.widthClass} width</div> : null}
          </div>
          <div className="rounded border border-white/[0.06] bg-black/25 px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-white/40">EMA Stack</div>
            <div className="text-xs font-bold text-white/85">{emaText}</div>
          </div>
          <div className="rounded border border-white/[0.06] bg-black/25 px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-white/40">VWAP</div>
            <div className="text-xs font-bold text-white/85">
              {data.spot.vwap > 0 ? (spot > data.spot.vwap ? "above" : "below") : "—"}
            </div>
          </div>
        </div>

        {/* Levels with per-level verdict */}
        <div>
          <div className="mb-1 grid grid-cols-12 gap-2 px-0.5 text-[9px] uppercase tracking-wider text-white/35">
            <span className="col-span-4">Level</span>
            <span className="col-span-4">Value</span>
            <span className="col-span-2 text-right">Δ</span>
            <span className="col-span-2 text-right">Verdict</span>
          </div>
          <Row label="VWAP" value={data.spot.vwap} spot={spot} verdict={verdictAbove(data.spot.vwap)} hint="Volume-weighted avg price" />
          <Row label="A-VWAP Session" value={data.avwap?.session} spot={spot} verdict={verdictAbove(data.avwap?.session)} hint="Anchored from session open" />
          <Row label="A-VWAP Prior" value={data.avwap?.priorDay} spot={spot} verdict={verdictAbove(data.avwap?.priorDay)} hint="Anchored ~60 bars back" />
          <Row label="EMA 9" value={data.spot.ema9} spot={spot} verdict={verdictAbove(data.spot.ema9)} />
          <Row label="EMA 20" value={data.spot.ema20} spot={spot} verdict={verdictAbove(data.spot.ema20)} />
          <Row label="EMA 50" value={data.spot.ema50} spot={spot} verdict={verdictAbove(data.spot.ema50)} />
          {cpr ? (
            <>
              <Row label="CPR Pivot" value={cpr.pivot} spot={spot} verdict={verdictAbove(cpr.pivot)} />
              <Row label="CPR TC" value={cpr.tc} spot={spot} verdict={cprVerdict} />
              <Row label="CPR BC" value={cpr.bc} spot={spot} verdict={cprVerdict} />
              <Row label="R1" value={cpr.r1} spot={spot} verdict={verdictAbove(cpr.r1)} />
              <Row label="S1" value={cpr.s1} spot={spot} verdict={verdictAbove(cpr.s1)} />
            </>
          ) : null}
          <Row label="POC" value={data.flow.volume.poc} spot={spot} verdict={verdictAbove(data.flow.volume.poc)} hint="Point of control" />
          <Row label="VAH" value={data.flow.volume.vah} spot={spot} verdict={verdictAbove(data.flow.volume.vah)} hint="Value Area High" />
          <Row label="VAL" value={data.flow.volume.val} spot={spot} verdict={verdictAbove(data.flow.volume.val)} hint="Value Area Low" />
          <Row label="Day High" value={data.spot.dayHigh} spot={spot} verdict="neutral" />
          <Row label="Day Low" value={data.spot.dayLow} spot={spot} verdict="neutral" />
          <Row label="PDH" value={data.spot.pdh} spot={spot} verdict={verdictAbove(data.spot.pdh)} hint="Prior day high" />
          <Row label="PDL" value={data.spot.pdl} spot={spot} verdict={verdictAbove(data.spot.pdl)} hint="Prior day low" />
          <Row label="Prior Close" value={data.spot.priorClose} spot={spot} verdict={verdictAbove(data.spot.priorClose)} />
        </div>
      </div>
    </Panel>
  );
}
