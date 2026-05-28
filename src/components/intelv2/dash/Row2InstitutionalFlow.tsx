import type { IntelV2Snapshot } from "@/lib/intelV2Types";
import { V2Card, V2Pill, v2Fmt, v2FmtSigned, v2FmtSignedCompact, V2_TONE, V2Hint } from "./common";

export function Row2InstitutionalFlow({ data }: { data: IntelV2Snapshot | null }) {
  return (
    <div className="grid h-[360px] grid-cols-12 gap-2">
      <div className="col-span-2 min-h-0"><SpotVsFutures data={data} /></div>
      <div className="col-span-3 min-h-0"><OiShift data={data} /></div>
      <div className="col-span-2 min-h-0"><OiBuildup data={data} /></div>
      <div className="col-span-2 min-h-0"><PremiumVelocity data={data} /></div>
      <div className="col-span-3 min-h-0"><FrvpInstitutional data={data} /></div>
    </div>
  );
}

// 2.1 SPOT vs FUTURES (compact — col-span-2)
function SpotVsFutures({ data }: { data: IntelV2Snapshot | null }) {
  const spot = data?.spot.ltp ?? null;
  const fut  = data?.futures.ltp ?? null;
  const basis = data?.futures.premium ?? null;
  const basisPct = (basis != null && spot) ? Number(((basis / spot) * 100).toFixed(2)) : null;
  const tone = basis == null ? "neutral" : basis >= 0 ? "bull" : "bear";
  const hint = data?.dashboard?.hints?.spotFut;
  return (
    <V2Card title="2.1 Spot vs Futures">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-col rounded-sm bg-white/[0.03] px-2 py-1">
          <span className="text-[10px] uppercase tracking-wide text-white/45">Spot</span>
          <span className="font-mono text-[15px] font-bold text-white">{v2Fmt(spot, 2)}</span>
        </div>
        <div className="flex flex-col rounded-sm bg-white/[0.03] px-2 py-1">
          <span className="text-[10px] uppercase tracking-wide text-white/45">Futures</span>
          <span className="font-mono text-[15px] font-bold text-white">{v2Fmt(fut, 2)}</span>
        </div>
        <div className="flex items-center justify-between rounded-sm bg-white/[0.03] px-2 py-1">
          <span className="text-[10px] uppercase tracking-wide text-white/55">Basis</span>
          <span className="font-mono text-[12px] font-bold" style={{ color: V2_TONE[tone].color }}>
            {v2FmtSigned(basis ?? 0, 2)}
          </span>
        </div>
        <div className="flex items-center justify-between rounded-sm bg-white/[0.03] px-2 py-1">
          <span className="text-[10px] uppercase tracking-wide text-white/55">Basis %</span>
          <span className="font-mono text-[12px] font-bold" style={{ color: V2_TONE[tone].color }}>
            {basisPct != null ? `${basisPct >= 0 ? "+" : ""}${basisPct.toFixed(2)}%` : "—"}
          </span>
        </div>
        <V2Pill
          label={basis == null ? "—" : basis >= 0 ? "Premium" : "Discount"}
          tone={tone as "bull" | "bear" | "neutral"}
          size="sm"
        />
      </div>
      <V2Hint label="Interpretation" tone={tone as "bull" | "bear" | "neutral"} text={hint || ""} />
    </V2Card>
  );
}

// 2.2 OI SHIFT (Active strikes)
function OiShift({ data }: { data: IntelV2Snapshot | null }) {
  // ATM ± 4 strikes, 100-spaced (backend already filters)
  const rows = data?.dashboard?.oiHistogram || [];
  const bias = data?.dashboard?.oiShiftBias;

  // Migration tag per row: PE Build / CE Build / Balanced
  const migrationLabel = (ce: number, pe: number) => {
    if (Math.abs(ce) < 1e3 && Math.abs(pe) < 1e3) return { label: "—", tone: "neutral" as const };
    if (pe > ce && pe > 0) return { label: "PE Build", tone: "bull" as const };
    if (ce > pe && ce > 0) return { label: "CE Build", tone: "bear" as const };
    if (ce < 0 && pe > 0) return { label: "PE Build", tone: "bull" as const };
    if (pe < 0 && ce > 0) return { label: "CE Build", tone: "bear" as const };
    return { label: "Balanced", tone: "neutral" as const };
  };

  // Bias bar colors
  const biasTone = bias?.side === "CALL" ? "bull"
    : bias?.side === "PUT" ? "bear" : "warn";
  const sideLabel = bias?.side === "CALL" ? "CALL FAVOURED"
    : bias?.side === "PUT" ? "PUT FAVOURED" : "BALANCED";
  const sideColor = V2_TONE[biasTone].color;
  const bullPct = bias?.bullishPct ?? 50;
  const bearPct = bias?.bearishPct ?? 50;

  return (
    <V2Card title="2.2 OI Shift (Active Strikes)">
      <div className="grid grid-cols-[58px_60px_60px_60px_1fr] items-center gap-1 px-1 pb-1 text-[10px] font-bold uppercase tracking-wider text-white/45">
        <span>Strike</span>
        <span className="text-center">CE</span>
        <span className="text-center">PE</span>
        <span className="text-right">Migration</span>
        <span className="pl-1 text-right">Buyer Favor</span>
      </div>
      <div className="flex flex-col gap-1">
        {[...rows].sort((a, b) => b.strike - a.strike).map((r) => {
          const ceTone = r.ceOiChg >= 0 ? "bear" : "bull";
          const peTone = r.peOiChg >= 0 ? "bull" : "bear";
          const mig = migrationLabel(r.ceOiChg, r.peOiChg);
          const cePct = r.ceFavorPct ?? 50;
          const pePct = r.peFavorPct ?? 50;
          const fav = r.favorSide || "NEUTRAL";
          const favColor = fav === "CE" ? V2_TONE.bull.color
                         : fav === "PE" ? V2_TONE.bear.color
                         : V2_TONE.warn.color;
          return (
            <div
              key={r.strike}
              className="grid grid-cols-[58px_60px_60px_60px_1fr] items-center gap-1 rounded-sm px-1.5 py-1 text-[12px]"
              style={{ background: r.isAtm ? "rgba(59,130,246,0.10)" : "transparent" }}
            >
              <span className="font-mono font-bold text-white/90">
                {r.strike}{r.isAtm ? <span className="ml-1 text-[9px] text-sky-300">ATM</span> : null}
              </span>
              <span className="text-center font-mono" style={{ color: V2_TONE[ceTone].color }}>
                {v2FmtSignedCompact(r.ceOiChg)}
              </span>
              <span className="text-center font-mono" style={{ color: V2_TONE[peTone].color }}>
                {v2FmtSignedCompact(r.peOiChg)}
              </span>
              <span className="text-right">
                <V2Pill label={mig.label} tone={mig.tone} size="xs" />
              </span>
              {/* Buyer Favor meter — CE green vs PE red split */}
              <div className="flex items-center gap-1.5 pl-1">
                <div className="relative flex h-2 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                  <div className="h-full bg-emerald-500/80" style={{ width: `${cePct}%` }} />
                  <div className="h-full bg-rose-500/80" style={{ width: `${pePct}%` }} />
                </div>
                <span
                  className="w-12 shrink-0 text-right font-mono text-[10px] font-bold tabular-nums"
                  style={{ color: favColor }}
                  title={`CE-buy ${r.ceBuyScore ?? 0}/100 vs PE-buy ${r.peBuyScore ?? 0}/100`}
                >
                  {fav === "NEUTRAL" ? "—" : `${fav} ${r.favorPct ?? 0}%`}
                </span>
              </div>
            </div>
          );
        })}
        {!rows.length ? (
          <div className="px-1 py-3 text-center text-[12px] text-white/45">No data</div>
        ) : null}
      </div>

      {/* Bias verdict — which side favours + % */}
      <div className="mt-2 flex flex-col gap-1.5 rounded-sm border border-white/[0.06] bg-white/[0.03] px-2.5 py-2">
        <div className="flex items-center justify-between text-[11px]">
          <span className="font-bold uppercase tracking-wider" style={{ color: sideColor }}>
            {sideLabel}
          </span>
          <span className="font-mono font-bold tabular-nums" style={{ color: sideColor }}>
            {bias?.pctFavour ?? 0}%
          </span>
        </div>
        {/* Two-segment bar — green (bullish flow) vs red (bearish flow) */}
        <div className="flex h-2 overflow-hidden rounded-full bg-white/[0.06]">
          <div className="h-full bg-emerald-500/80" style={{ width: `${bullPct}%` }} />
          <div className="h-full bg-rose-500/80" style={{ width: `${bearPct}%` }} />
        </div>
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-emerald-400">Bullish {bullPct}%</span>
          <span className="text-rose-400">Bearish {bearPct}%</span>
        </div>
      </div>

      {/* Trend block — direction, strength, dominant strike, build counts */}
      {bias?.trend ? (() => {
        const t = bias.trend;
        const dirTone = t.direction === "BULLISH" ? "bull"
          : t.direction === "BEARISH" ? "bear" : "warn";
        const dirColor = V2_TONE[dirTone].color;
        const dirArrow = t.direction === "BULLISH" ? "▲"
          : t.direction === "BEARISH" ? "▼" : "▬";
        const strengthTone = t.strength === "STRONG" ? "bull"
          : t.strength === "MODERATE" ? "warn" : "neutral";
        return (
          <div className="mt-1.5 flex flex-col gap-1 rounded-sm border border-white/[0.06] bg-white/[0.025] px-2.5 py-1.5">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider"
                    style={{ color: dirColor }}>
                <span className="text-[14px] leading-none">{dirArrow}</span>
                {t.direction} TREND
              </span>
              <V2Pill label={t.strength} tone={strengthTone as "bull" | "warn" | "neutral"} size="xs" />
            </div>
            {/* Momentum bar 0..100 */}
            <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className="absolute inset-y-0 left-0"
                style={{ width: `${Math.min(100, t.momentum)}%`, background: dirColor }}
              />
            </div>
            <div className="flex items-center justify-between text-[10px] text-white/65">
              <span>Momentum</span>
              <span className="font-mono font-bold" style={{ color: dirColor }}>
                {t.momentum}%
              </span>
            </div>
            {t.dominantStrike != null ? (
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-white/55">Dominant</span>
                <span className="font-mono font-bold text-white/85">
                  {t.dominantStrike}{" "}
                  <span style={{
                    color: t.dominantBuild?.startsWith("PE") ? "#22c55e" : "#ef4444",
                  }}>
                    {t.dominantBuild}
                  </span>
                </span>
              </div>
            ) : null}
            <div className="flex items-center justify-between text-[10px] text-white/55">
              <span className="text-emerald-400">PE Build × {t.putBuildCount}</span>
              <span className="text-rose-400">CE Build × {t.callBuildCount}</span>
            </div>
          </div>
        );
      })() : null}

      <V2Hint
        label={bias?.trend?.direction === "BULLISH" ? "Bullish Trend"
              : bias?.trend?.direction === "BEARISH" ? "Bearish Trend"
              : "Trend"}
        text={bias?.trend?.label || bias?.label || "Balanced"}
        tone={biasTone as "bull" | "bear" | "warn"}
      />
    </V2Card>
  );
}

// 2.3 OI BUILDUP ANALYSIS — strike-aware rows (e.g. "23900 PE +5.61L")
function OiBuildup({ data }: { data: IntelV2Snapshot | null }) {
  const b = data?.dashboard?.buildUp;
  const rows: Array<{
    label: string;
    detected: boolean;
    pickStrike: number | null;
    pickSide: "CE" | "PE" | null;
    pickDelta: number | null;
    tone: "bull" | "bear" | "warn" | "info";
  }> = [
    { label: "Long Buildup",  detected: !!b?.longBuildUp,
      pickStrike: b?.longBuildUpStrike?.strike ?? null,
      pickSide:   b?.longBuildUpStrike?.side ?? null,
      pickDelta:  b?.longBuildUpStrike?.delta ?? null,
      tone: "bull" },
    { label: "Short Buildup", detected: !!b?.shortBuildUp,
      pickStrike: b?.shortBuildUpStrike?.strike ?? null,
      pickSide:   b?.shortBuildUpStrike?.side ?? null,
      pickDelta:  b?.shortBuildUpStrike?.delta ?? null,
      tone: "bear" },
    { label: "Long Unwinding",detected: !!b?.longUnwinding,
      pickStrike: b?.longUnwindingStrike?.strike ?? null,
      pickSide:   b?.longUnwindingStrike?.side ?? null,
      pickDelta:  b?.longUnwindingStrike?.delta ?? null,
      tone: "warn" },
    { label: "Short Covering",detected: !!b?.shortCovering,
      pickStrike: b?.shortCoveringStrike?.strike ?? null,
      pickSide:   b?.shortCoveringStrike?.side ?? null,
      pickDelta:  b?.shortCoveringStrike?.delta ?? null,
      tone: "info" },
  ];
  return (
    <V2Card title="2.3 OI Buildup Analysis">
      <div className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <div
            key={r.label}
            className="flex items-center justify-between rounded-sm px-2 py-1.5 text-[12px]"
            style={{
              background: r.detected ? V2_TONE[r.tone].soft : "rgba(255,255,255,0.025)",
            }}
          >
            <span className="text-white/85">{r.label}</span>
            <span className="text-right font-mono">
              {r.pickStrike != null ? (
                <span style={{ color: V2_TONE[r.tone].color }}>
                  <span className="font-bold">{r.pickStrike}</span>{" "}
                  <span className="text-[10px] opacity-90">{r.pickSide}</span>{" "}
                  <span className="font-bold">{v2FmtSignedCompact(r.pickDelta)}</span>
                </span>
              ) : (
                <span className="text-white/45">—</span>
              )}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <div className="flex flex-col items-center rounded-sm bg-white/[0.03] px-2 py-1">
          <span className="text-[9px] uppercase text-white/45">Buildup Strength</span>
          <span className="font-mono text-[12px] font-bold text-emerald-400">{b?.strengthLabel || "MODERATE"}</span>
        </div>
        <div className="flex flex-col items-center rounded-sm bg-white/[0.03] px-2 py-1">
          <span className="text-[9px] uppercase text-white/45">Buildup Velocity</span>
          <span className="font-mono text-[12px] font-bold text-emerald-400">{b?.velocityLabel || "MODERATE"}</span>
        </div>
      </div>
      <V2Hint label="Interpretation" text={b?.interpretation || ""} tone="bull" />
    </V2Card>
  );
}

// 2.4 PREMIUM VELOCITY
function PremiumVelocity({ data }: { data: IntelV2Snapshot | null }) {
  const ce = data?.options?.atmCall?.ltp ?? null;
  const pe = data?.options?.atmPut?.ltp ?? null;
  const atmIv = data?.options?.atmIv ?? 0;
  const hint = data?.dashboard?.hints?.premiumVel;
  return (
    <V2Card title="2.4 Premium Velocity">
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col rounded-sm bg-emerald-400/[0.06] px-2.5 py-2">
          <span className="text-[10px] uppercase tracking-wide text-white/55">CE Premium</span>
          <span className="font-mono text-[16px] font-bold text-emerald-400">{v2Fmt(ce, 2)}</span>
        </div>
        <div className="flex flex-col rounded-sm bg-rose-400/[0.06] px-2.5 py-2">
          <span className="text-[10px] uppercase tracking-wide text-white/55">PE Premium</span>
          <span className="font-mono text-[16px] font-bold text-rose-400">{v2Fmt(pe, 2)}</span>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between rounded-sm bg-white/[0.03] px-2.5 py-1.5">
        <span className="text-[10px] uppercase tracking-wide text-white/55">ATM IV</span>
        <span className="font-mono text-[13px] font-bold text-white/85">{v2Fmt(atmIv, 2)}%</span>
      </div>
      <div className="mt-1.5 flex items-center justify-between rounded-sm bg-white/[0.03] px-2.5 py-1.5">
        <span className="text-[10px] uppercase tracking-wide text-white/55">Health</span>
        <V2Pill
          label={atmIv >= 12 && atmIv <= 30 ? "HEALTHY" : atmIv > 30 ? "EXPENSIVE" : "DEAD"}
          tone={atmIv >= 12 && atmIv <= 30 ? "bull" : atmIv > 30 ? "warn" : "bear"}
          size="sm"
        />
      </div>
      <V2Hint label="Spot vs Premium" text={hint || ""} tone="bull" />
    </V2Card>
  );
}

// 2.5 FRVP (Institutional Map) — replicates the screenshot exactly
function FrvpInstitutional({ data }: { data: IntelV2Snapshot | null }) {
  const f = data?.dashboard?.frvpInstitutional;
  const aux = data?.dashboard?.auctionIntensity;
  if (!f) {
    return (
      <V2Card title="2.5 FRVP (Institutional Map)">
        <div className="flex h-full items-center justify-center text-[12px] text-white/40">
          No volume profile yet
        </div>
      </V2Card>
    );
  }
  const markerLeft = `${100 - f.markerPct}%`; // markerPct=0 → at top/right (bullish)
  return (
    <V2Card title="2.5 FRVP (Institutional Map)">
      {/* TOP — VAH/POC/VAL on left, gradient bar with marker, Price/InsideValue/OutsideValue on right */}
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
        <div className="flex flex-col gap-1 text-[11px]">
          <Row label="VAH" value={v2Fmt(f.vah, 0)} mono color="#9ca3af" />
          <Row label="POC" value={v2Fmt(f.poc, 0)} mono color="#facc15" highlight />
          <Row label="VAL" value={v2Fmt(f.val, 0)} mono color="#9ca3af" />
        </div>
        <div className="relative flex h-12 items-center overflow-visible">
          {/* gradient bar: green → red */}
          <div
            className="h-1.5 w-full overflow-hidden rounded-full"
            style={{
              background: "linear-gradient(90deg, rgba(34,197,94,0.45) 0%, rgba(34,197,94,0.18) 50%, rgba(239,68,68,0.18) 50%, rgba(239,68,68,0.45) 100%)",
            }}
          />
          {/* marker (white dot + line) */}
          <div
            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{ left: markerLeft }}
          >
            <div className="flex flex-col items-center">
              <div className="h-4 w-0.5 bg-white/85" />
              <div className="h-3 w-3 rounded-full border border-white bg-white shadow" />
              <div className="h-4 w-0.5 bg-white/85" />
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-1 text-[11px]">
          <Row label="Price"        value={v2Fmt(f.price, 2)} mono color="#22c55e" />
          <Row label="Inside Value" value={f.insideValue}     pillTone={f.insideValue === "YES" ? "bull" : "bear"} />
          <Row label="Outside Value"value={f.outsideValue}    pillTone={f.outsideValue === "YES" ? "bull" : "bear"} />
        </div>
      </div>

      {/* BUYERS / SELLERS / PARTICIPATION grid */}
      <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
        <div>
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-emerald-400">BUYERS</div>
          <RowCompact label="Entering" value={`${f.buyers.entering}%`} valueColor="#22c55e" />
          <RowCompact label="Leaving"  value={`${f.buyers.leaving}%`}  valueColor="#22c55e" />
        </div>
        <div>
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-rose-400">SELLERS</div>
          <RowCompact label="Entering" value={`${f.sellers.entering}%`} valueColor="#ef4444" />
          <RowCompact label="Leaving"  value={`${f.sellers.leaving}%`}  valueColor="#ef4444" />
        </div>
        <div>
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-emerald-400">PARTICIPATION</div>
          <RowCompact label="Strike" value={f.participationStrike?.toString() || "—"} valueColor="#fff" />
          <RowCompact label="Level"  value={f.participationLevel || aux?.label?.split(" ")?.[0] || "—"} valueColor={f.participationLevel === "High" ? "#22c55e" : f.participationLevel === "Low" ? "#ef4444" : "#facc15"} />
        </div>
      </div>

      <V2Hint label="Interpretation" text={f.interpretation} tone="bull" />
    </V2Card>
  );
}

function Row({
  label, value, mono, highlight, pillTone, color,
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
  pillTone?: "bull" | "bear" | "warn" | "neutral";
  color?: string;
}) {
  return (
    <div className={`flex items-center justify-between gap-2 ${highlight ? "rounded-sm bg-amber-400/10 px-1" : ""}`}>
      <span className="text-[10px] uppercase tracking-wide text-white/55">{label}</span>
      {pillTone ? (
        <V2Pill label={value} tone={pillTone} size="xs" />
      ) : (
        <span
          className={`${mono ? "font-mono" : ""} text-[12px] font-bold tabular-nums`}
          style={{ color: color || "#e5e7eb" }}
        >
          {value}
        </span>
      )}
    </div>
  );
}

function RowCompact({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="flex items-center justify-between py-0.5 text-[11px]">
      <span className="text-white/55">{label}</span>
      <span className="font-mono font-bold tabular-nums" style={{ color: valueColor || "#fff" }}>{value}</span>
    </div>
  );
}
