import type { IntelV2Snapshot } from "@/lib/intelV2Types";
import { V2Card, V2Pill, v2Fmt, v2FmtCompact, V2_TONE } from "./common";
import { SupportResistanceCardV2 } from "./SupportResistanceCard";
import { TopStrikeCardV2 } from "./TopStrikeCard";

/**
 * Bottom panel — two stacked tiers:
 *   Tier A (260px): Support/Resistance Pressure | Top Strike Selection
 *   Tier B (220px): Intraday Price Action | Selected Option Chain | Key Levels
 */
export function Row6BottomPanel({ data }: { data: IntelV2Snapshot | null }) {
  return (
    <div className="grid min-h-0 flex-1 grid-rows-[260px_minmax(220px,1fr)] gap-2">
      {/* Tier A — SR + Top Strike */}
      <div className="grid min-h-0 grid-cols-12 gap-2">
        <div className="col-span-5 min-h-0"><SupportResistanceCardV2 data={data} /></div>
        <div className="col-span-7 min-h-0"><TopStrikeCardV2 data={data} /></div>
      </div>

      {/* Tier B — Tactical view */}
      <div className="grid min-h-0 grid-cols-12 gap-2">
        <div className="col-span-3 min-h-0"><PriceAction data={data} /></div>
        <div className="col-span-6 min-h-0"><SelectedOptionChain data={data} /></div>
        <div className="col-span-3 min-h-0"><KeyLevels data={data} /></div>
      </div>
    </div>
  );
}

function PriceAction({ data }: { data: IntelV2Snapshot | null }) {
  const candles = data?.dashboard?.spark1m || [];
  const closes = candles.map(c => c.c);
  const min = closes.length ? Math.min(...closes) : 0;
  const max = closes.length ? Math.max(...closes) : 0;
  const range = max - min || 1;
  const points = closes.map((c, i) => {
    const x = (i / Math.max(1, closes.length - 1)) * 100;
    const y = 100 - ((c - min) / range) * 100;
    return `${x},${y}`;
  }).join(" ");

  const struct = data?.regime?.dayType === "TREND DAY" ? "TRENDING"
    : data?.regime?.dayType === "VOLATILE DAY" ? "VOLATILE" : "SIDEWAYS";

  return (
    <V2Card title="Intraday Price Action">
      <div className="flex items-center gap-1.5 px-1 pb-1.5 text-[11px] text-white/55">
        <V2Pill label="1m" tone="info" size="xs" />
        <span>•</span>
        <V2Pill label={struct} tone={struct === "TRENDING" ? "bull" : struct === "VOLATILE" ? "warn" : "neutral"} size="xs" />
      </div>
      <div className="flex h-24 items-stretch overflow-hidden rounded-sm bg-white/[0.03] px-1 py-1">
        {closes.length ? (
          <svg viewBox="0 0 100 100" className="h-full w-full" preserveAspectRatio="none">
            <polyline
              points={points}
              fill="none"
              stroke={V2_TONE[(closes[closes.length - 1] || 0) >= (closes[0] || 0) ? "bull" : "bear"].color}
              strokeWidth="1.4"
            />
          </svg>
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[12px] text-white/45">No candles</div>
        )}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1.5 text-[12px]">
        <Row label="Structure" value={struct} />
        <Row label="Action" value={data?.tradePlan?.action === "BUY_CE" ? "BUY CE" : data?.tradePlan?.action === "BUY_PE" ? "BUY PE" : "WAIT"} />
        <Row label="Range" value={`${v2Fmt(data?.spot?.dayLow, 0)} – ${v2Fmt(data?.spot?.dayHigh, 0)}`} />
        <Row label="Key Zone" value={data?.options?.atm ? String(data.options.atm) : "—"} />
      </div>
    </V2Card>
  );
}

function SelectedOptionChain({ data }: { data: IntelV2Snapshot | null }) {
  const rows = data?.dashboard?.optionChainSnapshot || [];
  return (
    <V2Card title={`Selected Option Chain (ATM ± 2)`}>
      <div className="grid grid-cols-9 px-1 pb-1 text-[10px] font-bold uppercase tracking-wider text-white/45">
        <span>OI</span>
        <span>Δ OI</span>
        <span>IV</span>
        <span>LTP</span>
        <span className="text-center">Strike</span>
        <span>OI</span>
        <span>Δ OI</span>
        <span>IV</span>
        <span>LTP</span>
      </div>
      <div className="flex flex-col gap-1">
        {rows.map(r => (
          <div
            key={r.strike}
            className="grid grid-cols-9 rounded-sm px-1.5 py-1 text-[12px]"
            style={{ background: r.isAtm ? "rgba(59,130,246,0.10)" : "rgba(255,255,255,0.025)" }}
          >
            <span className="font-mono text-emerald-300/80">{v2FmtCompact(r.ce.oi)}</span>
            <span className={`font-mono ${r.ce.oiChg >= 0 ? "text-rose-400" : "text-emerald-400"}`}>
              {(r.ce.oiChg >= 0 ? "+" : "") + v2FmtCompact(r.ce.oiChg)}
            </span>
            <span className="font-mono text-white/65">{v2Fmt(r.ce.iv, 2)}</span>
            <span className="font-mono text-white/85">{v2Fmt(r.ce.ltp, 2)}</span>
            <span className="text-center font-mono font-bold text-white">
              {r.strike}{r.isAtm ? <span className="ml-1 text-[10px] text-sky-300">ATM</span> : null}
            </span>
            <span className="font-mono text-rose-300/80">{v2FmtCompact(r.pe.oi)}</span>
            <span className={`font-mono ${r.pe.oiChg >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
              {(r.pe.oiChg >= 0 ? "+" : "") + v2FmtCompact(r.pe.oiChg)}
            </span>
            <span className="font-mono text-white/65">{v2Fmt(r.pe.iv, 2)}</span>
            <span className="font-mono text-white/85">{v2Fmt(r.pe.ltp, 2)}</span>
          </div>
        ))}
        {!rows.length ? <div className="px-2 py-4 text-center text-[12px] text-white/45">No option chain</div> : null}
      </div>
      <div className="mt-1.5 px-1 text-[11px] text-white/55">
        Unusual Activity: {data?.options?.callWall ? `High CE OI Buildup at ${data.options.callWall}` : "—"}
        {data?.options?.putWall ? ` • Put Writing at ${data.options.putWall}` : ""}
      </div>
    </V2Card>
  );
}

function KeyLevels({ data }: { data: IntelV2Snapshot | null }) {
  const lvls = data?.dashboard?.keyLevels || [];
  const cpr = data?.cpr;
  return (
    <V2Card title="Key Levels">
      <div className="flex flex-col gap-1 text-[12px]">
        {lvls.map(l => {
          const tone = l.kind === "resistance" ? "bear" : l.kind === "support" ? "bull" : "warn";
          return (
            <div
              key={`${l.label}-${l.value}`}
              className="flex items-center justify-between rounded-sm px-2.5 py-1.5"
              style={{ background: V2_TONE[tone].soft }}
            >
              <span className="text-[12px] font-bold" style={{ color: V2_TONE[tone].color }}>
                {l.label}
              </span>
              <span className="font-mono text-[14px] font-bold tabular-nums text-white">
                {l.value}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-2.5 flex flex-col gap-1.5">
        <div className="rounded-sm bg-white/[0.03] px-2.5 py-1.5 text-[11px]">
          <span className="text-emerald-400">↑</span>{" "}
          <span className="text-white/85">Bullish Above {cpr ? cpr.r1.toFixed(0) : "—"}</span>
        </div>
        <div className="rounded-sm bg-white/[0.03] px-2.5 py-1.5 text-[11px]">
          <span className="text-rose-400">↓</span>{" "}
          <span className="text-white/85">Bearish Below {cpr ? cpr.s1.toFixed(0) : "—"}</span>
        </div>
        <div className="rounded-sm bg-white/[0.03] px-2.5 py-1.5 text-[11px]">
          <span className="text-amber-400">⚠</span>{" "}
          <span className="text-white/85">
            Range Between {cpr ? `${cpr.s1.toFixed(0)} – ${cpr.r1.toFixed(0)}` : "—"}
          </span>
        </div>
      </div>
    </V2Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-sm bg-white/[0.025] px-2.5 py-1.5">
      <span className="text-[11px] uppercase tracking-wider text-white/55">{label}</span>
      <span className="font-mono text-[12px] font-bold tabular-nums text-white/85">{value}</span>
    </div>
  );
}
