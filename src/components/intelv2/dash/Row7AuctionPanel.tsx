import type { IntelV2Snapshot } from "@/lib/intelV2Types";
import { V2Card, V2_TONE, v2Fmt, v2FmtCompact, V2Hint } from "./common";
import { cn } from "@/lib/utils";

export function Row7AuctionPanel({ data }: { data: IntelV2Snapshot | null }) {
  return (
    <div className="grid h-[360px] grid-cols-12 gap-2">
      <div className="col-span-5 min-h-0"><BuyerSellerFlow data={data} /></div>
      <div className="col-span-3 min-h-0"><AuctionIntensity data={data} /></div>
      <div className="col-span-4 min-h-0"><VwapAvwapIntraday data={data} /></div>
    </div>
  );
}

// 7.1 Buyer / Seller Flow Summary (CE / PE donuts)
function BuyerSellerFlow({ data }: { data: IntelV2Snapshot | null }) {
  const f = data?.dashboard?.buyerSellerFlow;
  const ce = f?.ce;
  const pe = f?.pe;

  const ceTone = (ce?.buyersPct ?? 50) >= 55 ? "bull" : (ce?.buyersPct ?? 50) <= 45 ? "bear" : "warn";
  const peTone = (pe?.buyersPct ?? 50) >= 55 ? "bull" : (pe?.buyersPct ?? 50) <= 45 ? "bear" : "warn";

  const interp = (f && (ce?.label?.includes("Buyers") || pe?.label?.includes("Buyers")))
    ? "Buyers dominant on both legs — supportive of breakouts."
    : "Mixed flow — wait for clear absorption.";

  return (
    <V2Card title="Buyer / Seller Flow Summary">
      <div className="grid grid-cols-2 gap-3">
        <Side
          label="CE FLOW (NET)"
          netLabel={`${(ce?.net ?? 0) >= 0 ? "+" : ""}${v2FmtCompact(Math.abs(ce?.net ?? 0))}`}
          stance={ce?.label || "—"}
          buyersPct={ce?.buyersPct ?? 50}
          tone={ceTone as "bull" | "bear" | "warn"}
          buyersAbs={ce?.buyersAbs ?? 0}
        />
        <Side
          label="PE FLOW (NET)"
          netLabel={`${(pe?.net ?? 0) >= 0 ? "+" : ""}${v2FmtCompact(Math.abs(pe?.net ?? 0))}`}
          stance={pe?.label || "—"}
          buyersPct={pe?.buyersPct ?? 50}
          tone={peTone as "bull" | "bear" | "warn"}
          buyersAbs={pe?.buyersAbs ?? 0}
        />
      </div>
      <V2Hint label="Interpretation" text={interp} tone="bull" />
    </V2Card>
  );
}

function Side({
  label, netLabel, stance, buyersPct, tone, buyersAbs,
}: {
  label: string;
  netLabel: string;
  stance: string;
  buyersPct: number;
  tone: "bull" | "bear" | "warn";
  buyersAbs: number;
}) {
  const headColor = tone === "bull" ? "text-emerald-400" : tone === "bear" ? "text-rose-400" : "text-amber-400";
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className={cn("text-[10px] font-bold uppercase tracking-[0.16em]", headColor)}>
        {label}
      </div>
      <div className={cn("font-mono text-[20px] font-black tabular-nums", headColor)}>
        {netLabel}
      </div>
      <div className="text-[11px] text-white/55">({stance})</div>
      <Donut percent={buyersPct} tone={tone} />
      <div className="grid grid-cols-1 text-center text-[11px]">
        <span className="font-mono font-bold text-emerald-400">Buyers (Coming)</span>
        <span className="font-mono text-white/85">{v2FmtCompact(buyersAbs)}</span>
        <span className="text-rose-400">Sellers (Leaving)</span>
      </div>
    </div>
  );
}

function Donut({ percent, tone }: { percent: number; tone: "bull" | "bear" | "warn" }) {
  const c = V2_TONE[tone].color;
  const r = 30;
  const len = 2 * Math.PI * r;
  const dash = (Math.max(0, Math.min(100, percent)) / 100) * len;
  return (
    <svg width="86" height="86" viewBox="0 0 80 80">
      <circle cx="40" cy="40" r={r} fill="none" stroke="rgba(239,68,68,0.4)" strokeWidth="7" />
      <circle
        cx="40" cy="40" r={r} fill="none"
        stroke={c} strokeWidth="7"
        strokeDasharray={`${dash} ${len}`}
        strokeLinecap="round"
        transform="rotate(-90 40 40)"
      />
      <text
        x="40" y="45" textAnchor="middle"
        style={{ fill: "#fff", fontSize: "16px", fontWeight: 800 }}
      >
        {Math.round(percent)}%
      </text>
    </svg>
  );
}

// 7.2 Auction Intensity (gauge)
function AuctionIntensity({ data }: { data: IntelV2Snapshot | null }) {
  const a = data?.dashboard?.auctionIntensity;
  const score = a?.score ?? 0;
  const tone = score >= 75 ? "bull" : score >= 55 ? "warn" : "bear";
  const c = V2_TONE[tone].color;

  // semicircle gauge: 0..100 → 180..0 deg
  const angle = ((100 - Math.max(0, Math.min(100, score))) / 100) * 180;
  const cx = 80, cy = 80, r = 60;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const px = cx + r * Math.cos(rad(180 - angle));
  const py = cy - r * Math.sin(rad(180 - angle));

  return (
    <V2Card title="Auction Intensity">
      <div className="flex flex-col items-center justify-center">
        <svg width="170" height="100" viewBox="0 0 160 95" className="overflow-visible">
          <defs>
            <linearGradient id="aiGradV2" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%"   stopColor="#ef4444" />
              <stop offset="50%"  stopColor="#f59e0b" />
              <stop offset="100%" stopColor="#22c55e" />
            </linearGradient>
          </defs>
          <path
            d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
            fill="none" stroke="url(#aiGradV2)" strokeWidth="14"
            strokeLinecap="round"
          />
          {/* needle */}
          <line x1={cx} y1={cy} x2={px} y2={py} stroke="#fff" strokeWidth="3" strokeLinecap="round" />
          <circle cx={cx} cy={cy} r="4" fill="#fff" />
          <text x={cx} y={cy - 12} textAnchor="middle" style={{ fill: c, fontSize: "20px", fontWeight: 800 }}>
            {Math.round(score)}%
          </text>
        </svg>
        <div className="-mt-2 flex w-full items-center justify-between px-3 text-[10px] text-white/55">
          <span>Weak</span>
          <span>Strong</span>
        </div>
        <div className="mt-1 text-center">
          <div className="font-mono text-[13px] font-bold" style={{ color: c }}>
            {a?.label || "—"}
          </div>
          <div className="text-[11px] text-white/65">{a?.hint || ""}</div>
        </div>
      </div>
    </V2Card>
  );
}

// 7.3 VWAP & AVWAP (Intraday)
function VwapAvwapIntraday({ data }: { data: IntelV2Snapshot | null }) {
  const v = data?.dashboard?.vwapAvwapIntraday;
  const above = v?.priceVsVwap === "Above";
  const tone = above ? "bull" : "bear";
  return (
    <V2Card title="VWAP & AVWAP (Intraday)">
      <div className="flex flex-col gap-2 text-[13px]">
        <Row label="VWAP"     value={v2Fmt(v?.vwap, 2)}     valueColor="#3b82f6" />
        <Row label="AVWAP (Day)" value={v2Fmt(v?.avwapDay, 2)} valueColor="#facc15" />
        <Row label="Price vs VWAP" value={v?.priceVsVwap || "—"} valueColor={above ? "#22c55e" : "#ef4444"} />
        <Row label="Bias"     value={v?.bias || "—"}        valueColor={above ? "#22c55e" : "#ef4444"} />
      </div>
      <V2Hint
        label="Bias"
        text={above ? "Price above VWAP — bullish control." : "Price below VWAP — bearish defensive."}
        tone={tone as "bull" | "bear"}
      />
    </V2Card>
  );
}

function Row({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="flex items-center justify-between rounded-sm bg-white/[0.03] px-3 py-2">
      <span className="text-[11px] uppercase tracking-wider text-white/55">{label}</span>
      <span className="font-mono text-[14px] font-bold tabular-nums" style={{ color: valueColor || "#e5e7eb" }}>
        {value}
      </span>
    </div>
  );
}
