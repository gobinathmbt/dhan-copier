import type { IntelV2Snapshot } from "@/lib/intelV2Types";
import { V2Card, V2Pill, v2Fmt, v2FmtSigned, v2FmtSignedCompact, V2_TONE } from "./common";

export function Row2InstitutionalFlow({ data }: { data: IntelV2Snapshot | null }) {
  return (
    <div className="grid h-[260px] grid-cols-12 gap-2">
      <div className="col-span-3 min-h-0"><SpotVsFutures data={data} /></div>
      <div className="col-span-2 min-h-0"><OiShift data={data} /></div>
      <div className="col-span-2 min-h-0"><OiBuildup data={data} /></div>
      <div className="col-span-2 min-h-0"><PremiumVelocity data={data} /></div>
      <div className="col-span-3 min-h-0"><Frvp data={data} /></div>
    </div>
  );
}

// 2.1 SPOT vs FUTURES
function SpotVsFutures({ data }: { data: IntelV2Snapshot | null }) {
  const spot = data?.spot.ltp ?? null;
  const fut  = data?.futures.ltp ?? null;
  const basis = data?.futures.premium ?? null;
  const basisPct = (basis != null && spot) ? Number(((basis / spot) * 100).toFixed(2)) : null;
  const tone = basis == null ? "neutral" : basis >= 0 ? "bull" : "bear";
  return (
    <V2Card title="2.1 Spot vs Futures">
      <div className="grid grid-cols-2 gap-3 text-[12px]">
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wide text-white/45">Spot</span>
          <span className="font-mono text-[18px] font-bold text-white">{v2Fmt(spot, 2)}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wide text-white/45">Futures</span>
          <span className="font-mono text-[18px] font-bold text-white">{v2Fmt(fut, 2)}</span>
        </div>
      </div>
      <div className="mt-2.5 flex items-center justify-between rounded-sm bg-white/[0.03] px-2.5 py-2">
        <span className="text-[10px] uppercase tracking-wide text-white/55">Basis</span>
        <span className="font-mono text-[14px] font-bold" style={{ color: V2_TONE[tone].color }}>
          {v2FmtSigned(basis ?? 0, 2)}
        </span>
      </div>
      <div className="mt-1.5 flex items-center justify-between rounded-sm bg-white/[0.03] px-2.5 py-2">
        <span className="text-[10px] uppercase tracking-wide text-white/55">Basis %</span>
        <span className="font-mono text-[14px] font-bold" style={{ color: V2_TONE[tone].color }}>
          {basisPct != null ? `${basisPct >= 0 ? "+" : ""}${basisPct.toFixed(2)}%` : "—"}
        </span>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <V2Pill
          label={basis == null ? "—" : basis >= 0 ? "Premium" : "Discount"}
          tone={tone as "bull" | "bear" | "neutral"}
          size="sm"
        />
        <span className="text-[11px] text-white/55">
          {data?.regime?.dayType === "TREND DAY" ? "Trend healthy" : "Sync watch"}
        </span>
      </div>
    </V2Card>
  );
}

// 2.2 OI SHIFT (Active strikes)
function OiShift({ data }: { data: IntelV2Snapshot | null }) {
  const rows = data?.dashboard?.oiHistogram?.slice(0, 6) || [];
  return (
    <V2Card title="2.2 OI Shift (Active)">
      <div className="grid grid-cols-3 px-1 pb-1 text-[10px] font-bold uppercase tracking-wider text-white/45">
        <span>Strike</span>
        <span className="text-right">CE Δ</span>
        <span className="text-right">PE Δ</span>
      </div>
      <div className="flex flex-col gap-1">
        {rows.map((r) => {
          const ceTone = r.ceOiChg >= 0 ? "bear" : "bull";
          const peTone = r.peOiChg >= 0 ? "bull" : "bear";
          return (
            <div
              key={r.strike}
              className="grid grid-cols-3 rounded-sm px-1.5 py-1 text-[12px]"
              style={{ background: r.isAtm ? "rgba(59,130,246,0.10)" : "transparent" }}
            >
              <span className="font-mono font-bold text-white/85">
                {r.strike}{r.isAtm ? <span className="ml-1 text-[9px] text-sky-300">ATM</span> : null}
              </span>
              <span className="text-right font-mono" style={{ color: V2_TONE[ceTone].color }}>
                {v2FmtSignedCompact(r.ceOiChg)}
              </span>
              <span className="text-right font-mono" style={{ color: V2_TONE[peTone].color }}>
                {v2FmtSignedCompact(r.peOiChg)}
              </span>
            </div>
          );
        })}
        {!rows.length ? (
          <div className="px-1 py-3 text-center text-[12px] text-white/45">No data</div>
        ) : null}
      </div>
    </V2Card>
  );
}

// 2.3 OI BUILDUP ANALYSIS
function OiBuildup({ data }: { data: IntelV2Snapshot | null }) {
  const oi = data?.flow?.oi;
  const rows = [
    { label: "Long Buildup",  detected: !!data?.dashboard?.buildUp?.longBuildUp,   value: oi?.peTotal,  tone: "bull" as const },
    { label: "Short Buildup", detected: !!data?.dashboard?.buildUp?.shortBuildUp,  value: oi?.ceTotal,  tone: "bear" as const },
    { label: "Long Unwinding",detected: !!data?.dashboard?.buildUp?.longUnwinding, value: 0,            tone: "warn" as const },
    { label: "Short Covering",detected: !!data?.dashboard?.buildUp?.shortCovering, value: 0,            tone: "info" as const },
  ];
  return (
    <V2Card title="2.3 OI Buildup">
      <div className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <div
            key={r.label}
            className="flex items-center justify-between rounded-sm px-2 py-1.5 text-[12px]"
            style={{
              background: r.detected ? V2_TONE[r.tone].soft : "rgba(255,255,255,0.025)",
            }}
          >
            <span className="text-white/80">{r.label}</span>
            <span className="font-mono font-bold" style={{ color: r.detected ? V2_TONE[r.tone].color : "#9ca3af" }}>
              {r.value ? v2FmtSignedCompact(r.value) : (r.detected ? "✓" : "—")}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex items-center justify-between rounded-sm bg-white/[0.03] px-2 py-1.5">
        <span className="text-[10px] uppercase tracking-wider text-white/55">Strength</span>
        <span className="text-[12px] font-bold text-emerald-400">
          {data?.bias?.overallBias === "bullish" ? "STRONG"
            : data?.bias?.overallBias === "bearish" ? "STRONG"
            : "MODERATE"}
        </span>
      </div>
    </V2Card>
  );
}

// 2.4 PREMIUM VELOCITY
function PremiumVelocity({ data }: { data: IntelV2Snapshot | null }) {
  const ce = data?.options?.atmCall?.ltp ?? null;
  const pe = data?.options?.atmPut?.ltp ?? null;
  const atmIv = data?.options?.atmIv ?? 0;
  return (
    <V2Card title="2.4 Premium Velocity">
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col rounded-sm bg-emerald-400/[0.06] px-2.5 py-1.5">
          <span className="text-[10px] uppercase tracking-wide text-white/55">CE Premium</span>
          <span className="font-mono text-[16px] font-bold text-emerald-400">{v2Fmt(ce, 2)}</span>
        </div>
        <div className="flex flex-col rounded-sm bg-rose-400/[0.06] px-2.5 py-1.5">
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
    </V2Card>
  );
}

// 2.5 FRVP (Institutional Map)
function Frvp({ data }: { data: IntelV2Snapshot | null }) {
  const v = data?.flow?.volume;
  const price = data?.spot?.ltp ?? 0;
  const buyers = data?.flow?.delta?.totalBuy ?? 0;
  const sellers = data?.flow?.delta?.totalSell ?? 0;
  const total = buyers + sellers || 1;
  const buyerPct = Math.round((buyers / total) * 100);
  const sellerPct = 100 - buyerPct;
  const above = data?.dashboard?.priceAbovePoc ?? null;
  return (
    <V2Card title="2.5 FRVP (Institutional Map)">
      <div className="grid grid-cols-2 gap-3 text-[12px]">
        <div className="flex flex-col gap-1.5">
          <Row label="VAH" value={v2Fmt(v?.vah, 2)} />
          <Row label="POC" value={v2Fmt(v?.poc, 2)} highlight />
          <Row label="VAL" value={v2Fmt(v?.val, 2)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Row label="Price" value={v2Fmt(price, 2)} />
          <Row label="Above POC" value={above != null ? `${above}%` : "—"} />
          <Row label="State" value={v ? "Acceptance" : "—"} />
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-2 rounded-sm bg-white/[0.03] px-2.5 py-1.5">
        <span className="text-[10px] uppercase tracking-wider text-white/55">Buyers</span>
        <div className="flex h-2 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
          <div className="h-full bg-emerald-500/80" style={{ width: `${buyerPct}%` }} />
          <div className="h-full bg-rose-500/80" style={{ width: `${sellerPct}%` }} />
        </div>
        <span className="text-[10px] uppercase tracking-wider text-white/55">Sellers</span>
      </div>
      <div className="flex justify-between text-[12px] mt-1">
        <span className="text-emerald-400 font-bold">{buyerPct}% Entering</span>
        <span className="text-rose-400 font-bold">{sellerPct}% Leaving</span>
      </div>
    </V2Card>
  );
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`flex items-center justify-between rounded-sm px-2 py-1 ${highlight ? "bg-sky-400/10" : ""}`}>
      <span className="text-[10px] uppercase tracking-wide text-white/55">{label}</span>
      <span className={`font-mono text-[13px] font-bold ${highlight ? "text-sky-300" : "text-white/85"}`}>
        {value}
      </span>
    </div>
  );
}
