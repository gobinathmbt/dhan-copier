import type { IntelV2Snapshot } from "@/lib/intelV2Types";
import { V2Card, V2_TONE, v2Fmt, v2FmtCompact, V2Hint } from "./common";
import { useMemo } from "react";

export function Row8FrvpAuctionProfile({ data }: { data: IntelV2Snapshot | null }) {
  return (
    <div className="grid h-[420px] grid-cols-12 gap-2">
      <div className="col-span-9 min-h-0"><AuctionProfile data={data} /></div>
      <div className="col-span-3 min-h-0"><AuctionInfoCard data={data} /></div>
    </div>
  );
}

function AuctionProfile({ data }: { data: IntelV2Snapshot | null }) {
  const f = data?.dashboard?.frvpAuction;
  const price = data?.spot?.ltp ?? 0;

  // Build a normalised horizontal bar list: price → bar width %
  const { items, priceMin, priceMax } = useMemo(() => {
    const bins = f?.bins || [];
    if (!bins.length) return { items: [], priceMin: 0, priceMax: 0 };
    const maxV = Math.max(...bins.map(b => b.volume), 1);
    const sorted = [...bins].sort((a, b) => b.price - a.price);
    return {
      items: sorted.map(b => ({ ...b, w: (b.volume / maxV) * 100 })),
      priceMin: Math.min(...bins.map(b => b.price)),
      priceMax: Math.max(...bins.map(b => b.price)),
    };
  }, [f?.bins]);

  if (!f) {
    return (
      <V2Card title="FRVP (Intraday Auction Profile)">
        <div className="flex h-full items-center justify-center text-[13px] text-white/45">
          No volume profile yet
        </div>
      </V2Card>
    );
  }

  // helper: y position 0..100 for a price within [priceMin,priceMax]
  const yFor = (p: number) => {
    if (priceMax === priceMin) return 50;
    return ((priceMax - p) / (priceMax - priceMin)) * 100;
  };

  return (
    <V2Card title="FRVP (Intraday Auction Profile)">
      <div className="flex h-full gap-3">
        {/* Profile area */}
        <div className="relative flex-1">
          {/* bars */}
          <div className="absolute inset-0 flex flex-col-reverse">
            {items.map((b) => (
              <div
                key={b.price}
                className="relative flex h-[3.5px] w-full items-center"
              >
                <div
                  className="h-full rounded-r"
                  style={{
                    width: `${b.w}%`,
                    background: "rgba(99,102,241,0.55)",
                  }}
                />
              </div>
            ))}
          </div>
          {/* dashed levels */}
          {[
            { p: f.vah, label: "VAH", color: "#ef4444" },
            { p: f.ibHigh ?? null, label: "IB High", color: "#a855f7" },
            { p: f.poc, label: "POC", color: "#facc15" },
            { p: f.ibLow ?? null,  label: "IB Low",  color: "#a855f7" },
            { p: f.val, label: "VAL", color: "#22c55e" },
          ].filter(l => l.p != null).map(l => (
            <div
              key={l.label}
              className="absolute left-0 right-0"
              style={{ top: `${yFor(l.p as number)}%` }}
            >
              <div
                className="h-px w-full"
                style={{ borderTop: `1.5px dashed ${l.color}` }}
              />
              <span
                className="absolute right-2 -translate-y-1/2 text-[10px] font-bold"
                style={{ color: l.color }}
              >
                {l.label} {v2Fmt(l.p as number, 0)}
              </span>
            </div>
          ))}
          {/* price marker (live) */}
          {price > 0 ? (
            <div
              className="absolute left-0 right-0"
              style={{ top: `${yFor(price)}%` }}
            >
              <div
                className="absolute right-1 -translate-y-1/2 rounded-sm bg-emerald-500/90 px-2 py-0.5 text-[10px] font-bold text-black"
              >
                {v2Fmt(price, 2)}
              </div>
              <div className="h-px w-full bg-emerald-400/60" />
            </div>
          ) : null}
          {/* high/low labels */}
          <div className="absolute right-2 top-0 text-right text-[10px] text-white/55">
            High {v2Fmt(f.sessionHigh, 2)}
          </div>
          <div className="absolute right-2 bottom-0 text-right text-[10px] text-white/55">
            Low {v2Fmt(f.sessionLow, 2)}
          </div>
        </div>
      </div>
      <div className="mt-1 flex items-center gap-3 text-[10px]">
        <Legend color="#ef4444" label="POC" />
        <Legend color="#22c55e" label="VAH" />
        <Legend color="#a855f7" label="VAL" />
        <Legend color="#9ca3af" label="IB High" />
        <Legend color="#9ca3af" label="IB Low" />
      </div>
    </V2Card>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1 text-white/55">
      <span className="h-2 w-3" style={{ background: color }} />
      {label}
    </span>
  );
}

function AuctionInfoCard({ data }: { data: IntelV2Snapshot | null }) {
  const f = data?.dashboard?.frvpAuction;
  if (!f) {
    return (
      <V2Card title="Auction Information">
        <div className="text-[12px] text-white/45">No data</div>
      </V2Card>
    );
  }
  const tone = f.summary.tone === "bull" ? "bull" : f.summary.tone === "bear" ? "bear" : "warn";
  const summaryAngle = ((100 - Math.max(0, Math.min(100, f.summary.score))) / 100) * 180;
  const cx = 80, cy = 80, r = 60;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const px = cx + r * Math.cos(rad(180 - summaryAngle));
  const py = cy - r * Math.sin(rad(180 - summaryAngle));
  const c = V2_TONE[tone as "bull" | "bear" | "warn"].color;

  return (
    <V2Card title="Auction Information">
      <div className="flex flex-col gap-1 text-[12px]">
        <Row label="POC"            value={v2Fmt(f.poc, 0)} valueColor="#facc15" />
        <Row label="VAH"            value={v2Fmt(f.vah, 0)} valueColor="#ef4444" />
        <Row label="VAL"            value={v2Fmt(f.val, 0)} valueColor="#22c55e" />
        <Row label="Inside Value (IB)" value={f.insideValueRange} />
        <Row label="Value Area %"    value={`${f.valueAreaPct.toFixed(2)}%`} />
        <Row label="Total Volume"    value={v2FmtCompact(f.totalVolume)} />
        <Row label="Volume (IB)"     value={v2FmtCompact(f.volumeIB)} />
        <Row label="Volume (OOR)"    value={v2FmtCompact(f.volumeOOR)} />
        <Row label="POC Type"        value={f.pocType} />
        <Row label="Auction Bias"    value={f.auctionBias} valueColor={f.auctionBias === "Above Value" ? "#22c55e" : f.auctionBias === "Below Value" ? "#ef4444" : "#facc15"} />
        <Row label="Initiative"      value={f.initiative} valueColor={f.initiative === "Buyers" ? "#22c55e" : f.initiative === "Sellers" ? "#ef4444" : "#9ca3af"} />
        <Row label="Acceptance Above VAH" value={f.acceptedAboveVAH} valueColor={f.acceptedAboveVAH === "Yes" ? "#22c55e" : "#ef4444"} />
        <Row label="Rejection Below VAL"  value={f.rejectedBelowVAL} valueColor={f.rejectedBelowVAL === "Yes" ? "#22c55e" : "#ef4444"} />
      </div>
      {/* Summary gauge */}
      <div className="mt-2 rounded-md border border-white/[0.06] bg-white/[0.03] p-2">
        <div className="text-[10px] font-bold uppercase tracking-wider text-white/55">FRVP Summary</div>
        <div className="flex items-center gap-2">
          <svg width="120" height="70" viewBox="0 0 160 95" className="overflow-visible">
            <defs>
              <linearGradient id="frvpGradV2" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%"   stopColor="#ef4444" />
                <stop offset="50%"  stopColor="#f59e0b" />
                <stop offset="100%" stopColor="#22c55e" />
              </linearGradient>
            </defs>
            <path
              d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
              fill="none" stroke="url(#frvpGradV2)" strokeWidth="14"
              strokeLinecap="round"
            />
            <line x1={cx} y1={cy} x2={px} y2={py} stroke="#fff" strokeWidth="3" strokeLinecap="round" />
            <circle cx={cx} cy={cy} r="4" fill="#fff" />
            <text x={cx} y={cy - 10} textAnchor="middle" style={{ fill: c, fontSize: "20px", fontWeight: 800 }}>
              {Math.round(f.summary.score)}%
            </text>
          </svg>
          <div className="flex flex-col">
            <span className="font-mono text-[12px] font-bold" style={{ color: c }}>
              {f.summary.label}
            </span>
            <span className="text-[10px] text-white/55">{f.summary.sub}</span>
          </div>
        </div>
      </div>
      <V2Hint label="Auction" text={f.summary.sub} tone={tone as "bull" | "bear" | "warn"} />
    </V2Card>
  );
}

function Row({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="flex items-center justify-between rounded-sm bg-white/[0.025] px-2.5 py-1">
      <span className="text-[11px] text-white/55">{label}</span>
      <span className="font-mono text-[12px] font-bold tabular-nums" style={{ color: valueColor || "#e5e7eb" }}>
        {value}
      </span>
    </div>
  );
}
