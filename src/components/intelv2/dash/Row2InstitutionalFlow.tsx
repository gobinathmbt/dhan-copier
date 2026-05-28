import type { IntelV2Snapshot } from "@/lib/intelV2Types";
import { V2Card, V2Pill, v2Fmt, v2FmtSigned, v2FmtSignedCompact, V2_TONE, V2Hint } from "./common";
import { OiBuildupAnalysisCard } from "./OiBuildupAnalysisCard";
import { SupportResistanceCardV2 } from "./SupportResistanceCard";

export function Row2InstitutionalFlow({ data }: { data: IntelV2Snapshot | null }) {
  return (
    <div className="flex flex-col gap-2">
      {/* Top compact row — Spot/Fut, OI Shift, FRVP Institutional Map */}
      <div className="grid h-[360px] grid-cols-12 gap-2">
        <div className="col-span-2 min-h-0"><SpotVsFutures data={data} /></div>
        <div className="col-span-5 min-h-0"><OiShift data={data} /></div>
        <div className="col-span-5 min-h-0"><FrvpInstitutional data={data} /></div>
      </div>

      {/* Big institutional OI Buildup Analysis (60%) + Support/Resistance Pressure (40%) */}
      <div className="grid min-h-[640px] grid-cols-10 gap-2">
        <div className="col-span-6 min-h-0">
          <OiBuildupAnalysisCard data={data} />
        </div>
        <div className="col-span-4 min-h-0">
          <SupportResistanceCardV2 data={data} />
        </div>
      </div>
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

// 2.5 FRVP (Institutional Map) — replicates the screenshot exactly
function FrvpInstitutional({ data }: { data: IntelV2Snapshot | null }) {
  const f = data?.dashboard?.frvpInstitutional;
  if (!f) {
    return (
      <V2Card title="2.5 FRVP (Institutional Map)">
        <div className="flex h-full items-center justify-center text-[12px] text-white/40">
          No volume profile yet
        </div>
      </V2Card>
    );
  }
  const e = f.engine;
  const markerLeft = `${100 - (e?.location?.markerPct ?? f.markerPct)}%`;

  // Tone resolution — engine drives if available, else legacy fallback
  const verdictTone = e?.interpretation?.tone === "bull" ? "bull"
    : e?.interpretation?.tone === "bear" ? "bear"
    : e?.interpretation?.tone === "neutral" ? "neutral" : "warn";
  const verdictColor = V2_TONE[verdictTone].color;

  // Top-line directional bias (Section 11)
  const dirBias = e?.directionalBias;
  const biasTone = dirBias?.side === "CE" ? "bull"
    : dirBias?.side === "PE" ? "bear" : "warn";
  const biasColor = V2_TONE[biasTone].color;

  // Acceptance / rejection signals
  const acc = e?.acceptance;
  const trap = e?.advanced?.trapped;
  const trapActive = !!trap;

  // Dominance
  const dom = e?.dominance;
  const buyersScore  = dom?.buyersScore  ?? Math.round((f.buyers.entering + (100 - f.sellers.entering)) / 2);
  const sellersScore = dom?.sellersScore ?? (100 - buyersScore);
  const domSide = dom?.dominantSide || (buyersScore >= 60 ? "BUYERS" : sellersScore >= 60 ? "SELLERS" : "BALANCED");
  const domTone = domSide === "BUYERS" ? "bull" : domSide === "SELLERS" ? "bear" : "warn";
  const domColor = V2_TONE[domTone].color;

  // Flow (CE / PE buyers separately for the meter)
  const ceBuyersPct = e?.flow?.ceBuyersPct ?? 50;
  const peBuyersPct = e?.flow?.peBuyersPct ?? 50;

  // Profile + advanced overlays
  const profile = e?.profile;
  const advanced = e?.advanced;

  return (
    <V2Card
      title={
        <span className="flex items-center gap-2">
          2.5 FRVP (Institutional Map)
          {trapActive ? (
            <span
              className="animate-pulse rounded-sm bg-rose-500/30 px-1.5 py-0.5 text-[10px] font-bold tracking-widest text-rose-300"
              title={trap?.detail}
            >
              ⚠ {trap?.side}
            </span>
          ) : null}
        </span>
      }
    >
      {/* ── TOP STRIP — VAH / POC / VAL + gradient bar with marker + Spot status */}
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
        <div className="flex flex-col gap-1 text-[11px]">
          <Row label="VAH" value={v2Fmt(profile?.vah ?? f.vah, 0)} mono color="#9ca3af" />
          <Row label="POC" value={v2Fmt(profile?.poc ?? f.poc, 0)} mono color="#facc15" highlight />
          <Row label="VAL" value={v2Fmt(profile?.val ?? f.val, 0)} mono color="#9ca3af" />
        </div>
        <div className="relative flex h-14 flex-col items-stretch justify-center">
          <div className="mb-1 flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.16em]">
            <span className="text-emerald-400">CE Zone</span>
            <span className="text-white/55">
              {e?.location?.side === "above_value" ? "Above Value"
                : e?.location?.side === "below_value" ? "Below Value"
                : e?.location?.nearPOC ? "Near POC"
                : "Inside Value"}
            </span>
            <span className="text-rose-400">PE Zone</span>
          </div>
          <div className="relative">
            <div
              className="h-2 w-full overflow-hidden rounded-full"
              style={{
                background: "linear-gradient(90deg, rgba(34,197,94,0.45) 0%, rgba(34,197,94,0.18) 50%, rgba(239,68,68,0.18) 50%, rgba(239,68,68,0.45) 100%)",
              }}
            />
            <div className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: markerLeft }}>
              <div className="flex flex-col items-center">
                <div className="h-4 w-0.5 bg-white/85" />
                <div className="h-3 w-3 rounded-full border border-white bg-white shadow" />
                <div className="h-4 w-0.5 bg-white/85" />
              </div>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-1 text-[11px]">
          <Row label="Price" value={v2Fmt(f.price, 2)} mono color="#22c55e" />
          <Row label="Inside" value={f.insideValue} pillTone={f.insideValue === "YES" ? "bull" : "bear"} />
          <Row label="Outside" value={f.outsideValue} pillTone={f.outsideValue === "YES" ? "bull" : "bear"} />
        </div>
      </div>

      {/* ── ACCEPTANCE / REJECTION ribbon ───────────────────────────── */}
      {acc ? (
        <div className="mt-2 grid grid-cols-2 gap-1.5 text-[10px]">
          <AcceptTile
            label="Above VAH"
            accepted={acc.acceptedAboveVAH}
            rejected={acc.rejectedAboveVAH}
            bars={acc.consecutiveAbove}
            volumeSurge={acc.volumeSurgeAbove}
          />
          <AcceptTile
            label="Below VAL"
            accepted={acc.acceptedBelowVAL}
            rejected={acc.rejectedBelowVAL}
            bars={acc.consecutiveBelow}
            volumeSurge={acc.volumeSurgeBelow}
          />
        </div>
      ) : null}

      {/* ── BUYERS / SELLERS / PARTICIPATION grid ─────────────────── */}
      <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
        <div className="rounded-sm border border-emerald-500/20 bg-emerald-500/[0.04] px-2 py-1.5">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-emerald-400">BUYERS</div>
          <CompactPair label="Entering" value={`${f.buyers.entering}%`} valueColor="#22c55e" />
          <CompactPair label="CE Side"  value={`${ceBuyersPct.toFixed(0)}%`} valueColor="#22c55e" />
        </div>
        <div className="rounded-sm border border-rose-500/20 bg-rose-500/[0.04] px-2 py-1.5">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-rose-400">SELLERS</div>
          <CompactPair label="Entering" value={`${f.sellers.entering}%`} valueColor="#ef4444" />
          <CompactPair label="PE Side"  value={`${peBuyersPct.toFixed(0)}%`} valueColor="#ef4444" />
        </div>
        <div className="rounded-sm border border-sky-500/20 bg-sky-500/[0.04] px-2 py-1.5">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-sky-300">PARTICIPATION</div>
          <CompactPair label="Strike" value={f.participationStrike?.toString() || "—"} valueColor="#fff" />
          <CompactPair
            label="Strength"
            value={profile ? `${profile.profileStrength.toFixed(0)}%` : f.participationLevel || "—"}
            valueColor={profile ? (profile.profileStrength >= 35 ? "#22c55e" : profile.profileStrength <= 15 ? "#ef4444" : "#facc15") : "#facc15"}
          />
        </div>
      </div>

      {/* ── DOMINANCE METER ─────────────────────────────────────────── */}
      <div className="mt-2 flex flex-col gap-1.5 rounded-sm border border-white/[0.06] bg-white/[0.03] px-2.5 py-2">
        <div className="flex items-center justify-between text-[11px]">
          <span className="font-bold uppercase tracking-wider" style={{ color: domColor }}>
            {domSide === "BUYERS" ? "BUYERS DOMINATING"
             : domSide === "SELLERS" ? "SELLERS DOMINATING"
             : "BALANCED FLOW"}
          </span>
          <span className="flex items-center gap-1.5 font-mono font-bold tabular-nums" style={{ color: domColor }}>
            {Math.round(Math.max(buyersScore, sellersScore))}%
            {dom?.conviction === "high"
              ? <span className="rounded-sm bg-emerald-500/20 px-1.5 py-0.5 text-[9px] tracking-wider text-emerald-300">CONFIRMED</span>
              : dom?.conviction === "divergent"
                ? <span className="rounded-sm bg-amber-500/20 px-1.5 py-0.5 text-[9px] tracking-wider text-amber-300">DIVERGENT</span>
                : null}
          </span>
        </div>
        <div className="flex h-2 overflow-hidden rounded-full bg-white/[0.06]">
          <div className="h-full bg-emerald-500/80" style={{ width: `${buyersScore}%` }} />
          <div className="h-full bg-rose-500/80" style={{ width: `${sellersScore}%` }} />
        </div>
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-emerald-400">Buyers {Math.round(buyersScore)}%</span>
          <span className="text-white/45 font-mono">
            Δ {e?.delta?.deltaPct != null ? `${e.delta.deltaPct >= 0 ? "+" : ""}${e.delta.deltaPct.toFixed(1)}%` : "—"}
          </span>
          <span className="text-rose-400">Sellers {Math.round(sellersScore)}%</span>
        </div>
        <div className="text-center text-[9px] uppercase tracking-[0.18em] text-white/35">
          Buyer Dominant Flow Estimate · Not Orderbook Tape
        </div>
      </div>

      {/* ── DIRECTIONAL BIAS for option buyers (CE / PE / NEUTRAL) ─── */}
      {dirBias ? (
        <div
          className="mt-2 flex items-center justify-between rounded-sm border px-2.5 py-1.5 text-[11px]"
          style={{ borderColor: `${biasColor}55`, background: `${biasColor}10` }}
        >
          <span className="font-bold uppercase tracking-[0.14em]" style={{ color: biasColor }}>
            {dirBias.side === "CE" ? "BUY CE" : dirBias.side === "PE" ? "BUY PE" : "WAIT"}
          </span>
          <V2Pill label={dirBias.strength} tone={biasTone as "bull" | "bear" | "warn"} size="xs" />
          <span className="text-[10px] text-white/65">{dirBias.reason}</span>
        </div>
      ) : null}

      {/* ── ADVANCED OVERLAYS ──────────────────────────────────────── */}
      {advanced ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
          {advanced.gammaWall ? (
            <Badge label="Gamma Wall" value={String(advanced.gammaWall.strike)} tone="purple" />
          ) : null}
          {advanced.premiumVel ? (
            <Badge
              label="Premium"
              value={advanced.premiumVel.state.replace("_", " ")}
              tone={advanced.premiumVel.state === "CE_EXPANDING" ? "bull"
                : advanced.premiumVel.state === "PE_EXPANDING" ? "bear" : "warn"}
            />
          ) : null}
          {advanced.nakedPOC ? (
            <Badge label="Naked POC" value={String(advanced.nakedPOC.price)} tone="info" />
          ) : null}
          {advanced.developingPOC && advanced.developingPOC.length >= 2 ? (
            <Badge
              label="POC Trail"
              value={(() => {
                const arr = advanced.developingPOC;
                const start = arr[0].poc;
                const end = arr[arr.length - 1].poc;
                return end > start ? "↑ Migrating Up"
                  : end < start ? "↓ Migrating Down"
                  : "→ Flat";
              })()}
              tone={(() => {
                const arr = advanced.developingPOC;
                const start = arr[0].poc;
                const end = arr[arr.length - 1].poc;
                return end > start ? "bull" : end < start ? "bear" : "neutral";
              })()}
            />
          ) : null}
        </div>
      ) : null}

      <V2Hint
        label={e?.interpretation?.verdict?.replace(/_/g, " ") || "Interpretation"}
        text={e?.interpretation?.summary || f.interpretation}
        tone={verdictTone as "bull" | "bear" | "warn" | "neutral"}
      />
    </V2Card>
  );
}

// ── Small helpers used by the FRVP card ────────────────────────────────
function AcceptTile({
  label, accepted, rejected, bars, volumeSurge,
}: {
  label: string;
  accepted: boolean;
  rejected: boolean;
  bars: number;
  volumeSurge: boolean;
}) {
  let state = "Probing";
  let tone: "bull" | "bear" | "warn" | "neutral" = "neutral";
  if (rejected)      { state = "Rejected"; tone = "bear"; }
  else if (accepted) { state = "Accepted"; tone = "bull"; }
  else if (bars > 0) { state = `${bars} bar${bars > 1 ? "s" : ""}`; tone = "warn"; }
  return (
    <div
      className="flex items-center justify-between rounded-sm border px-2 py-1.5"
      style={{ borderColor: V2_TONE[tone].border, background: V2_TONE[tone].soft }}
    >
      <span className="text-[10px] font-bold uppercase tracking-wider text-white/65">{label}</span>
      <span className="flex items-center gap-1 text-[10px] font-bold tabular-nums" style={{ color: V2_TONE[tone].color }}>
        {state}
        {volumeSurge ? <span className="rounded-sm bg-white/[0.08] px-1 text-[9px]">Vol↑</span> : null}
      </span>
    </div>
  );
}

function Badge({ label, value, tone }: { label: string; value: string; tone: "bull" | "bear" | "warn" | "info" | "purple" | "neutral" }) {
  const t = V2_TONE[tone];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5"
      style={{ borderColor: t.border, background: t.soft }}
    >
      <span className="text-[9px] uppercase tracking-wider text-white/55">{label}</span>
      <span className="font-mono text-[10px] font-bold" style={{ color: t.color }}>{value}</span>
    </span>
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

// Compact label+value pair — tighter horizontal spacing for FRVP grid
function CompactPair({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="flex items-baseline gap-1.5 py-0.5 text-[11px]">
      <span className="text-white/55">{label}</span>
      <span className="ml-auto font-mono font-bold tabular-nums" style={{ color: valueColor || "#fff" }}>{value}</span>
    </div>
  );
}
