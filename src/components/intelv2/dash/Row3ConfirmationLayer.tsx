import type { IntelV2Snapshot } from "@/lib/intelV2Types";
import { V2Card, V2Pill, v2Fmt, v2FmtSigned, v2FmtSignedCompact, V2_TONE, V2Hint, V2MiniPie } from "./common";
import { FiiDiiCard } from "./FiiDiiCard";

export function Row3ConfirmationLayer({ data }: { data: IntelV2Snapshot | null }) {
  return (
    <div className="grid h-[360px] grid-cols-12 gap-2">
      <div className="col-span-3 min-h-0"><DeltaVolume data={data} /></div>
      <div className="col-span-3 min-h-0"><MarketBreadth data={data} /></div>
      <div className="col-span-3 min-h-0"><Heavyweights data={data} /></div>
      <div className="col-span-3 min-h-0"><IvVix data={data} /></div>
      {/* <div className="col-span-3 min-h-0"><FiiDiiCard data={data} /></div> */}
    </div>
  );
}

// 3.1 Delta + Volume
function DeltaVolume({ data }: { data: IntelV2Snapshot | null }) {
  const d = data?.flow?.delta;
  const aggrTone = d?.bias === "bullish" ? "bull" : d?.bias === "bearish" ? "bear" : "neutral";
  const aggrLabel = d?.bias === "bullish" ? "BUYING" : d?.bias === "bearish" ? "SELLING" : "BALANCED";
  const hint = data?.dashboard?.hints?.delta;
  const buyPct = Math.round(((d?.totalBuy ?? 0) / Math.max(1, (d?.totalBuy ?? 0) + (d?.totalSell ?? 0))) * 100);
  const piePct = aggrTone === "bear" ? 100 - buyPct : buyPct;
  return (
    <V2Card title="3.1 Delta + Volume">
      <div className="grid grid-cols-[120px_1fr] items-center gap-3">
        <div className="flex items-center justify-center">
          <V2MiniPie value={piePct} tone={aggrTone as "bull" | "bear" | "neutral"} size={110} label={aggrTone === "bull" ? "BUY" : aggrTone === "bear" ? "SELL" : "MIX"} />
        </div>
        <div className="flex flex-col gap-1.5 text-[12px]">
        <div className="flex items-center justify-between">
          <span className="text-white/65">Aggression</span>
          <V2Pill label={aggrLabel} tone={aggrTone as "bull" | "bear" | "neutral"} size="sm" />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-white/65">Bid/Ask Imb</span>
          <span className="font-mono text-white/85">
            {v2FmtSigned(data?.dashboard?.delta?.bidAskImbalance ?? 0, 2)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-white/65">Net Delta</span>
          <span className="font-mono font-bold" style={{ color: V2_TONE[aggrTone].color }}>
            {v2FmtSignedCompact(d?.netDelta ?? 0)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-white/65">Volume Exp</span>
          <V2Pill
            label={Math.abs(d?.cvd ?? 0) > 8 ? "HIGH" : "NORMAL"}
            tone={Math.abs(d?.cvd ?? 0) > 8 ? "bull" : "neutral"}
            size="sm"
          />
        </div>
        </div>
      </div>
      <div className="mt-2 rounded-sm bg-white/[0.03] px-2 py-1.5 text-[11px] text-white/65">
        Real Buying Strength: <span className="font-bold text-emerald-400">
          {buyPct}%
        </span>
      </div>
      <V2Hint label="Interpretation" text={hint || ""} tone={aggrTone as "bull" | "bear" | "neutral"} />
    </V2Card>
  );
}

// 3.2 Market Breadth
function MarketBreadth({ data }: { data: IntelV2Snapshot | null }) {
  const b = data?.dashboard?.breadth;
  const adv = b?.advancing ?? 0;
  const dec = b?.declining ?? 0;
  const total = (b?.total ?? 0) || (adv + dec + (b?.unchanged ?? 0)) || 1;
  const advPct = b?.advancePct ?? Math.round((adv / total) * 100);
  const tone = advPct >= 60 ? "bull" : advPct >= 40 ? "warn" : "bear";
  const label = advPct >= 65 ? "BULLISH" : advPct >= 50 ? "NEUTRAL" : "BEARISH";

  return (
    <V2Card title="3.2 Market Breadth">
      <div className="grid grid-cols-[120px_1fr] items-center gap-3">
        <div className="flex items-center justify-center">
          <V2MiniPie value={advPct} tone={tone as "bull" | "bear" | "warn"} size={110} label={label} />
        </div>
        <div className="grid grid-cols-2 gap-2 text-[12px]">
          <div className="flex flex-col">
            <span className="text-white/55">Advancing</span>
            <span className="font-mono text-[15px] font-bold text-emerald-400">{adv}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-white/55">Declining</span>
            <span className="font-mono text-[15px] font-bold text-rose-400">{dec}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-white/55">A/D Ratio</span>
            <span className="font-mono text-[13px] text-white/85">{v2Fmt(b?.adRatio, 2)}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-white/55">Participation</span>
            <span className="font-mono text-[13px] text-white/85">{Math.round(((adv + dec) / total) * 100)}%</span>
          </div>
        </div>
      </div>
      <V2Hint label="Breadth Strength" text={b?.interpretation || data?.dashboard?.hints?.breadth || ""} tone={tone as "bull" | "bear" | "warn"} />
    </V2Card>
  );
}

function Donut({ percent, tone }: { percent: number; tone: "bull" | "bear" | "warn" }) {
  const c = V2_TONE[tone].color;
  const r = 22;
  const len = 2 * Math.PI * r;
  const dash = (Math.max(0, Math.min(100, percent)) / 100) * len;
  return (
    <svg width="64" height="64" viewBox="0 0 60 60">
      <circle cx="30" cy="30" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="6" />
      <circle
        cx="30" cy="30" r={r} fill="none"
        stroke={c} strokeWidth="6"
        strokeDasharray={`${dash} ${len}`}
        strokeLinecap="round"
        transform="rotate(-90 30 30)"
      />
      <text
        x="30" y="34" textAnchor="middle"
        style={{ fill: "#fff", fontSize: "13px", fontWeight: 800 }}
      >
        {Math.round(percent)}%
      </text>
    </svg>
  );
}

// 3.3 Heavyweights Alignment
function Heavyweights({ data }: { data: IntelV2Snapshot | null }) {
  const rows = (data?.dashboard?.heavyweightsImpact || []).slice(0, 6);
  const align = data?.dashboard?.heavyweightsAlignment;
  const alignedPct = align && align.total > 0 ? Math.round((align.aligned / align.total) * 100) : 0;
  const totalImpact = data?.dashboard?.heavyweightsTotalImpact ?? 0;
  const tone: "bull" | "bear" | "warn" = totalImpact > 0.1 ? "bull" : totalImpact < -0.1 ? "bear" : "warn";
  return (
    <V2Card title="3.3 Heavyweights Alignment">
      <div className="grid grid-cols-[120px_1fr] items-start gap-3">
        <div className="flex items-center justify-center pt-1">
          <V2MiniPie value={alignedPct} tone={tone} size={110} label={`${align?.aligned ?? 0}/${align?.total ?? 0}`} showPct={false} />
        </div>
        <div className="flex flex-col">
          <div className="grid grid-cols-4 px-1 pb-0.5 text-[10px] font-bold uppercase tracking-wider text-white/45">
            <span>Stock</span>
            <span className="text-right">Price</span>
            <span className="text-right">Contrib</span>
            <span className="text-right">Align</span>
          </div>
          <div className="flex flex-col gap-1 overflow-y-auto" style={{ maxHeight: 130 }}>
            {rows.map((r) => {
              const rTone = r.changePct >= 0 ? "bull" : "bear";
              return (
                <div key={r.symbol} className="grid grid-cols-4 px-1 text-[12px]">
                  <span className="font-mono font-bold text-white/85 truncate">{r.symbol}</span>
                  <span className="text-right font-mono text-white/65">{v2Fmt(r.last, 2)}</span>
                  <span className="text-right font-mono" style={{ color: V2_TONE[rTone].color }}>
                    {v2FmtSigned(r.impactPts, 1)}
                  </span>
                  <span className="text-right">
                    <V2Pill
                      label={r.changePct >= 0 ? "Bullish" : "Bearish"}
                      tone={rTone as "bull" | "bear"}
                      size="xs"
                    />
                  </span>
                </div>
              );
            })}
            {!rows.length ? <div className="text-center text-[12px] text-white/45">No data</div> : null}
          </div>
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between rounded-sm bg-white/[0.03] px-2 py-1.5">
        <span className="text-[10px] uppercase tracking-wider text-white/55">Alignment Score</span>
        <span className="font-mono text-[12px] font-bold" style={{ color: V2_TONE[tone].color }}>
          {align?.score || `0/0`} • {align?.label || "Mixed"}
        </span>
      </div>
      <V2Hint label="Heavyweights" text={data?.dashboard?.hints?.heavy || ""} tone={tone} />
    </V2Card>
  );
}

// 3.4 IV / VIX
function IvVix({ data }: { data: IntelV2Snapshot | null }) {
  const iv = data?.dashboard?.ivAnalytics;
  const vix = iv?.vix ?? null;
  const vixPct = iv?.vixChangePct ?? null;
  const atmIv = iv?.atmIv ?? 0;
  const ivRankScore = iv?.ivRank?.score ?? 0;
  const ivTone: "bull" | "bear" | "warn" =
    iv?.ivRank?.tone === "bull" ? "bull"
    : iv?.ivRank?.tone === "bear" ? "bear"
    : "warn";
  return (
    <V2Card title="3.4 IV / VIX">
      <div className="grid grid-cols-[120px_1fr] items-center gap-3">
        <div className="flex items-center justify-center">
          <V2MiniPie value={ivRankScore} tone={ivTone} size={110} label={iv?.ivRank?.label || "IV"} />
        </div>
        <div className="flex flex-col gap-1.5 text-[12px]">
        <div className="flex items-center justify-between rounded-sm bg-white/[0.03] px-2.5 py-1.5">
          <span className="text-white/65">India VIX</span>
          <span className="font-mono text-[14px] font-bold text-white">
            {v2Fmt(vix, 2)}
          </span>
        </div>
        <div className="flex items-center justify-between px-2.5 text-[11px]">
          <span className="text-white/55">VIX Δ %</span>
          <span className={`font-mono font-bold ${(vixPct ?? 0) >= 0 ? "text-rose-400" : "text-emerald-400"}`}>
            {vixPct != null ? `${vixPct >= 0 ? "+" : ""}${vixPct.toFixed(2)}%` : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between rounded-sm bg-white/[0.03] px-2.5 py-1.5">
          <span className="text-white/65">ATM IV</span>
          <span className="font-mono text-[14px] font-bold text-sky-300">{v2Fmt(atmIv, 2)}%</span>
        </div>
        <div className="flex items-center justify-between px-2.5 text-[11px]">
          <span className="text-white/55">IV Crush</span>
          <V2Pill
            label={vixPct != null && vixPct < -3 ? "YES" : "NO"}
            tone={vixPct != null && vixPct < -3 ? "warn" : "neutral"}
            size="xs"
          />
        </div>
        </div>
      </div>
      <V2Hint label="IV Trend" text={iv?.interpretation || data?.dashboard?.hints?.ivVix || ""} tone="info" />
    </V2Card>
  );
}

// 3.5 FII / DII Flow
function FiiDii({ data }: { data: IntelV2Snapshot | null }) {
  const fd = data?.macro?.fiiDii;
  const fii = fd?.cash?.fii;
  const dii = fd?.cash?.dii;
  const fiiVal = Number(fii?.buy_sell_difference) || 0;
  const diiVal = Number(dii?.buy_sell_difference) || 0;
  const net = (fiiVal + diiVal) / 100;
  const tone = net > 0 ? "bull" : net < 0 ? "bear" : "neutral";
  return (
    <V2Card title="3.5 FII / DII Flow">
      <div className="grid grid-cols-3 px-1 pb-0.5 text-[10px] font-bold uppercase tracking-wider text-white/45">
        <span>Player</span>
        <span className="text-right">Net (₹ Cr)</span>
        <span className="text-right">Stance</span>
      </div>
      <div className="flex flex-col gap-1">
        <Row3 label="FII (Cash)" value={v2FmtSigned((fiiVal ?? 0) / 100, 2)} action={fii?.net_action || "—"} />
        <Row3 label="DII (Cash)" value={v2FmtSigned((diiVal ?? 0) / 100, 2)} action={dii?.net_action || "—"} />
      </div>
      <div className="mt-2.5 flex items-center justify-between rounded-sm bg-white/[0.03] px-2.5 py-1.5">
        <span className="text-[11px] uppercase tracking-wider text-white/55">Overall Trend</span>
        <V2Pill
          label={tone === "bull" ? "Bullish" : tone === "bear" ? "Bearish" : "Neutral"}
          tone={tone as "bull" | "bear" | "neutral"}
          size="sm"
        />
      </div>
      <div className="mt-1.5 text-[11px] text-white/45">
        Source: Sensibull • {fd?.date || "—"}
      </div>
      <V2Hint label="Flow" text={tone === "bull" ? "Institutions net buyers — supportive flow." : tone === "bear" ? "Institutions net sellers — defensive bias." : "Mixed institutional flow."} tone={tone as "bull" | "bear" | "neutral"} />
    </V2Card>
  );
}

function Row3({ label, value, action }: { label: string; value: string; action: string }) {
  const positive = value.startsWith("+");
  const tone = positive ? "bull" : value.startsWith("-") ? "bear" : "neutral";
  return (
    <div className="grid grid-cols-3 px-1 text-[12px] py-0.5">
      <span className="font-mono text-white/85">{label}</span>
      <span className="text-right font-mono font-bold" style={{ color: V2_TONE[tone].color }}>{value}</span>
      <span className="text-right">
        <V2Pill label={action} tone={tone as "bull" | "bear" | "neutral"} size="xs" />
      </span>
    </div>
  );
}
