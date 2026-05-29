import type { IntelV2Snapshot } from "@/lib/intelV2Types";
import { V2Card, V2Pill, v2Fmt, V2_TONE, V2Hint, V2MiniPie } from "./common";

export function Row4StructureContext({ data }: { data: IntelV2Snapshot | null }) {
  return (
    <div className="grid h-[300px] grid-cols-12 gap-2">
      <div className="col-span-3 min-h-0"><Vwap data={data} /></div>
      <div className="col-span-3 min-h-0"><EmaStack data={data} /></div>
      <div className="col-span-3 min-h-0"><CprDaily data={data} /></div>
      <div className="col-span-3 min-h-0"><MaxPain data={data} /></div>
      {/* 4.6 GIFT Nifty â€” COMMENTED OUT
          (already shown in Row1 top quote ribbon as one of the 8 institutional
          quote tiles; rendering it here was duplicate). To re-enable, uncomment
          the line below and adjust the col-span values above back to 2/3/2/2/3. */}
      {/* <div className="col-span-3 min-h-0"><GiftNifty data={data} /></div> */}
    </div>
  );
}

function Vwap({ data }: { data: IntelV2Snapshot | null }) {
  const spot = data?.spot.ltp ?? 0;
  const vwap = data?.spot.vwap ?? null;
  const avwap = data?.avwap?.priorDay ?? null;
  const aboveV = vwap != null && spot > vwap;
  const aboveA = avwap != null && spot > avwap;
  // Pie pct = how far above VWAP. 0% = neutral, 100% = max stretch (≥ 0.5%).
  const distancePct = vwap ? Math.min(100, Math.abs((spot - vwap) / vwap) * 100 * 200) : 0;
  const pieValue = aboveV ? distancePct : 100 - distancePct;
  const tone: "bull" | "bear" = aboveV ? "bull" : "bear";
  return (
    <V2Card title="4.1 VWAP / AVWAP">
      <div className="grid grid-cols-[120px_1fr] items-center gap-3">
        <div className="flex items-center justify-center">
          <V2MiniPie value={pieValue} tone={tone} size={110} label={aboveV ? "ABOVE" : "BELOW"} showPct={false} />
        </div>
        <div className="flex flex-col gap-1.5 text-[12px]">
        <Row label="VWAP"  value={v2Fmt(vwap, 2)}  pill={aboveV ? "PRICE ABOVE" : "PRICE BELOW"} tone={aboveV ? "bull" : "bear"} />
        <Row label="AVWAP" value={v2Fmt(avwap, 2)} pill={aboveA ? "PRICE ABOVE" : "PRICE BELOW"} tone={aboveA ? "bull" : "bear"} />
        <div className="mt-1 flex items-center justify-between rounded-sm bg-white/[0.03] px-2.5 py-1.5">
          <span className="text-[11px] uppercase tracking-wider text-white/55">Reclaim</span>
          <V2Pill label={aboveV ? "YES" : "NO"} tone={aboveV ? "bull" : "bear"} size="sm" />
        </div>
        </div>
      </div>
      <V2Hint label="Status" text={data?.dashboard?.hints?.vwap || ""} tone={aboveV ? "bull" : "bear"} />
    </V2Card>
  );
}

function EmaStack({ data }: { data: IntelV2Snapshot | null }) {
  const e9 = data?.spot.ema9 ?? null;
  const e20 = data?.spot.ema20 ?? null;
  const e50 = data?.spot.ema50 ?? null;
  const ascending = (e9 ?? 0) > (e20 ?? 0) && (e20 ?? 0) > (e50 ?? 0);
  const descending = (e9 ?? 0) < (e20 ?? 0) && (e20 ?? 0) < (e50 ?? 0);
  const trend = ascending ? "BULLISH" : descending ? "BEARISH" : "MIXED";
  const tone: "bull" | "bear" | "warn" = ascending ? "bull" : descending ? "bear" : "warn";
  // Pie pct = how aligned the stack is. Each ordered pair (e9>e20, e20>e50) = 50%.
  const aligned = (((e9 ?? 0) > (e20 ?? 0) ? 1 : 0) + ((e20 ?? 0) > (e50 ?? 0) ? 1 : 0)) * 50;
  const piePct = ascending ? 100 : descending ? 100 : aligned === 50 ? 50 : aligned;
  return (
    <V2Card title="4.2 EMA (9/20/50)">
      <div className="grid grid-cols-[120px_1fr] items-center gap-3">
        <div className="flex items-center justify-center">
          <V2MiniPie value={piePct} tone={tone} size={110} label={trend} showPct={false} />
        </div>
        <div className="flex flex-col gap-1.5 text-[12px]">
        <Row label="EMA 9"  value={v2Fmt(e9, 2)} />
        <Row label="EMA 20" value={v2Fmt(e20, 2)} />
        <Row label="EMA 50" value={v2Fmt(e50, 2)} />
        <div className="mt-1 flex items-center justify-between rounded-sm bg-white/[0.03] px-2.5 py-1.5">
          <span className="text-[11px] uppercase tracking-wider text-white/55">Trend</span>
          <V2Pill label={trend} tone={tone} size="sm" />
        </div>
        </div>
      </div>
      <V2Hint label="Trend" text={data?.dashboard?.hints?.ema || ""} tone={tone} />
    </V2Card>
  );
}

function CprDaily({ data }: { data: IntelV2Snapshot | null }) {
  const c = data?.cpr;
  const spot = data?.spot.ltp ?? 0;
  const aboveTC = c && spot > c.tc;
  const belowBC = c && spot < c.bc;
  const insideCpr = c && !aboveTC && !belowBC;
  const tone: "bull" | "bear" | "warn" = aboveTC ? "bull" : belowBC ? "bear" : "warn";
  // Pie pct = bias strength. ABOVE/BELOW pivot = 100, inside CPR = 50.
  const piePct = aboveTC || belowBC ? 100 : insideCpr ? 50 : 0;
  return (
    <V2Card title="4.3 CPR (Daily)">
      <div className="grid grid-cols-[120px_1fr] items-center gap-3">
        <div className="flex items-center justify-center">
          <V2MiniPie value={piePct} tone={tone} size={110} label={aboveTC ? "ABOVE" : belowBC ? "BELOW" : "INSIDE"} showPct={false} />
        </div>
        <div className="flex flex-col gap-1.5 text-[12px]">
        <Row label="TC"    value={v2Fmt(c?.tc, 2)} />
        <Row label="Pivot" value={v2Fmt(c?.pivot, 2)} />
        <Row label="BC"    value={v2Fmt(c?.bc, 2)} />
        <div className="mt-1 flex items-center justify-between rounded-sm bg-white/[0.03] px-2.5 py-1.5">
          <span className="text-[11px] uppercase tracking-wider text-white/55">Status</span>
          <V2Pill
            label={aboveTC ? "Above Pivot" : belowBC ? "Below Pivot" : "Inside CPR"}
            tone={tone}
            size="sm"
          />
        </div>
        </div>
      </div>
      <V2Hint label="CPR" text={data?.dashboard?.hints?.cpr || ""} tone={tone} />
    </V2Card>
  );
}

function MaxPain({ data }: { data: IntelV2Snapshot | null }) {
  const mp = data?.options?.maxPain ?? null;
  const expiry = data?.options?.expiry || data?.tradingDay?.expiryDate || null;
  const dh = data?.spot.dayHigh ?? 0;
  const dl = data?.spot.dayLow ?? 0;
  const spot = data?.spot.ltp ?? 0;
  // Pie pct = how far spot is from Max Pain (0% = at MP, 100% = far from MP)
  // Tone: bull when spot < MP (mean reversion target up), bear when spot > MP.
  let piePct = 0;
  let tone: "bull" | "bear" | "warn" = "warn";
  if (mp && spot) {
    const range = Math.max(1, dh - dl);
    const dist = Math.abs(spot - mp);
    piePct = Math.min(100, (dist / range) * 100);
    tone = spot < mp ? "bull" : spot > mp ? "bear" : "warn";
  }
  return (
    <V2Card title="4.4 Max Pain">
      <div className="grid grid-cols-[120px_1fr] items-center gap-3">
        <div className="flex items-center justify-center">
          <V2MiniPie value={piePct} tone={tone} size={110} label={spot < (mp ?? 0) ? "BELOW MP" : spot > (mp ?? 0) ? "ABOVE MP" : "AT MP"} showPct={false} />
        </div>
        <div className="flex flex-col gap-1.5 text-[12px]">
        <Row label="Max Pain" value={v2Fmt(mp, 0)} />
        <Row label="Expiry"   value={typeof expiry === "string" ? expiry.slice(0, 10) : "—"} />
        <Row label="Range"    value={`${v2Fmt(dl, 0)} – ${v2Fmt(dh, 0)}`} />
        <div className="mt-1 flex items-center justify-between rounded-sm bg-white/[0.03] px-2.5 py-1.5">
          <span className="text-[11px] uppercase tracking-wider text-white/55">Bias</span>
          <V2Pill label={spot < (mp ?? 0) ? "BULL DRAW" : spot > (mp ?? 0) ? "BEAR DRAW" : "NEUTRAL"} tone={tone} size="sm" />
        </div>
        </div>
      </div>
      <V2Hint label="Range Bias" text={data?.dashboard?.hints?.maxPain || ""} tone={tone} />
    </V2Card>
  );
}

function PcrHidden(_props: { data: IntelV2Snapshot | null }) {
  // 4.5 PCR (Hidden) removed per user request — PCR is already shown in
  // the OI Buildup Analysis card (Row 2.3) under "CE/PE OI Ratio".
  return null;
}

function GiftNifty({ data }: { data: IntelV2Snapshot | null }) {
  const g = data?.macro?.giftNifty ?? null;
  const us = data?.macro?.usFutures;
  const sp = us?.sp500?.changePct ?? null;
  const positive = (g?.changePct ?? 0) >= 0;
  return (
    <V2Card title="4.6 GIFT Nifty">
      <div className="flex flex-col gap-1.5 text-[12px]">
        <Row label="GIFT Nifty" value={v2Fmt(g?.price, 2)} />
        <Row
          label="Δ %"
          value={g?.changePct != null ? `${g.changePct >= 0 ? "+" : ""}${g.changePct.toFixed(2)}%` : "—"}
          tone={positive ? "bull" : "bear"}
        />
        <Row
          label="S&P Fut"
          value={sp != null ? `${sp >= 0 ? "+" : ""}${sp.toFixed(2)}%` : "—"}
          tone={(sp ?? 0) >= 0 ? "bull" : "bear"}
        />
        <div className="mt-1 flex items-center justify-between rounded-sm bg-white/[0.03] px-2.5 py-1.5">
          <span className="text-[11px] uppercase tracking-wider text-white/55">Cues</span>
          <V2Pill
            label={positive ? "Positive Global" : "Negative Global"}
            tone={positive ? "bull" : "bear"}
            size="sm"
          />
        </div>
      </div>
      <V2Hint label="Cues" text={data?.dashboard?.hints?.gift || ""} tone={positive ? "bull" : "bear"} />
    </V2Card>
  );
}

function Row({
  label, value, pill, tone,
}: {
  label: string;
  value: string;
  pill?: string;
  tone?: keyof typeof V2_TONE;
}) {
  return (
    <div className="flex items-center justify-between rounded-sm bg-white/[0.025] px-2.5 py-1.5">
      <span className="text-[11px] uppercase tracking-wider text-white/55">{label}</span>
      <div className="flex items-center gap-2">
        <span
          className="font-mono text-[13px] font-bold tabular-nums"
          style={{ color: tone ? V2_TONE[tone].color : "rgba(255,255,255,0.85)" }}
        >
          {value}
        </span>
        {pill ? (
          <V2Pill label={pill} tone={tone as "bull" | "bear" | "warn" | "neutral" || "neutral"} size="xs" />
        ) : null}
      </div>
    </div>
  );
}
