import type { IntelV3Snapshot, IntelV3Symbol } from "@/lib/intelV3Types";
import { V3_TONE, v3Fmt, v3FmtPct } from "./common";

interface Props {
  data: IntelV3Snapshot | null;
  symbol: IntelV3Symbol;
  onSymbol: (s: IntelV3Symbol) => void;
  date: string | null;
  onDate: (d: string | null) => void;
  availableDates: string[];
  loading: boolean;
  lastFetchAt: number | null;
  onRefresh: () => void;
}

const SYMBOLS: IntelV3Symbol[] = ["NIFTY_50", "BANKNIFTY", "SENSEX"];

export function TopHeaderV3({
  data, symbol, onSymbol, date, onDate, availableDates, loading, lastFetchAt, onRefresh,
}: Props) {
  const sb = data?.statusBar;
  const spotPrice = sb?.spot.ltp ?? data?.spot?.ltp ?? null;
  const spotChange = sb?.spot.change ?? 0;
  const spotChangePct = sb?.spot.changePct ?? 0;
  const isLive = sb?.live ?? false;
  const ageSec = lastFetchAt ? Math.floor((Date.now() - lastFetchAt) / 1000) : null;

  const biasTone = sb?.bias.tone || "neutral";
  const biasColor = V3_TONE[biasTone].color;
  const pcrColor = sb?.pcr.label === "Bullish" ? V3_TONE.bull.color
    : sb?.pcr.label === "Bearish" ? V3_TONE.bear.color : V3_TONE.warn.color;
  const trendColor = sb?.trendStrength.label === "STRONG" ? V3_TONE.bull.color
    : sb?.trendStrength.label === "WEAK" ? V3_TONE.bear.color : V3_TONE.warn.color;
  const vwapColor = V3_TONE[sb?.vwap.tone || "neutral"].color;

  return (
    <div className="flex shrink-0 items-stretch gap-1.5 border-b border-white/[0.06] bg-[#0a0d12] px-2 py-1.5">
      {/* SPOT PRICE */}
      <Tile>
        <Lbl text="SPOT PRICE" right={
          <span className={`text-[11px] ${spotChange >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
            {spotChange >= 0 ? "▲" : "▼"}
          </span>
        } />
        <div className="font-mono text-[16px] font-bold leading-none text-white">{v3Fmt(spotPrice, 2)}</div>
        <div className={`text-[10px] font-bold leading-tight ${spotChange >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
          {spotChange >= 0 ? "+" : ""}{spotChange.toFixed(2)} ({v3FmtPct(spotChangePct, 2)})
        </div>
      </Tile>

      {/* MARKET BIAS */}
      <Tile tone={biasTone}>
        <Lbl text="MARKET BIAS" icon={biasTone === "bear" ? "🐻" : biasTone === "bull" ? "🐂" : "▬"} />
        <div className="text-[12px] font-bold leading-tight" style={{ color: biasColor }}>
          {sb?.bias.label || "—"}
        </div>
        <div className="truncate text-[9px] text-white/55">{sb?.bias.subtitle}</div>
      </Tile>

      {/* PCR */}
      <Tile>
        <Lbl text="PCR (CE/PE)" />
        <div className="font-mono text-[16px] font-bold leading-none text-white">{(sb?.pcr.value ?? 0).toFixed(2)}</div>
        <div className="text-[10px] font-bold" style={{ color: pcrColor }}>{sb?.pcr.label}</div>
      </Tile>

      {/* TREND STRENGTH */}
      <Tile>
        <Lbl text="TREND" />
        <div className="text-[12px] font-bold leading-tight" style={{ color: trendColor }}>
          {sb?.trendStrength.label || "—"}
        </div>
        <span className="mt-0.5 flex gap-[2px]">
          {Array.from({ length: 7 }).map((_, i) => {
            const filled = i < Math.round(((sb?.trendStrength.barFill ?? 50) / 100) * 7);
            return <span key={i} className="block h-1.5 w-1.5 rounded-[1px]"
                     style={{ background: filled ? trendColor : "rgba(255,255,255,0.10)" }} />;
          })}
        </span>
      </Tile>

      {/* VWAP BIAS */}
      <Tile>
        <Lbl text="VWAP BIAS" />
        <div className="text-[12px] font-bold leading-tight" style={{ color: vwapColor }}>{sb?.vwap.label || "—"}</div>
        <div className="font-mono text-[10px] text-white/65">{v3Fmt(sb?.vwap.value, 2)}</div>
      </Tile>

      {/* DOWNSIDE / UPSIDE — wider */}
      <Tile className="flex-[1.4]">
        <div className="grid grid-cols-2 gap-1">
          <div className="text-center">
            <div className="text-[8px] font-bold uppercase tracking-wider text-rose-400">DOWNSIDE</div>
            <div className="font-mono text-[14px] font-bold leading-none text-rose-400">{sb?.downsideUpside.downside ?? 0}%</div>
          </div>
          <div className="text-center">
            <div className="text-[8px] font-bold uppercase tracking-wider text-emerald-400">UPSIDE</div>
            <div className="font-mono text-[14px] font-bold leading-none text-emerald-400">{sb?.downsideUpside.upside ?? 0}%</div>
          </div>
        </div>
        <div className="mt-1 flex h-1 overflow-hidden rounded-full bg-white/[0.06]">
          <div className="h-full bg-rose-500/80" style={{ width: `${sb?.downsideUpside.downside ?? 50}%` }} />
          <div className="h-full bg-emerald-500/80" style={{ width: `${sb?.downsideUpside.upside ?? 50}%` }} />
        </div>
      </Tile>

      {/* LIVE / clock */}
      <Tile>
        <div className="flex items-center gap-1">
          <span className={`h-1.5 w-1.5 rounded-full ${isLive ? "animate-pulse bg-emerald-500" : "bg-white/30"}`} />
          <span className={`text-[9px] font-bold uppercase tracking-wider ${isLive ? "text-emerald-400" : "text-white/45"}`}>
            {isLive ? "LIVE" : "OFFLINE"}
          </span>
        </div>
        <div className="font-mono text-[14px] font-bold leading-none text-white">{sb?.clock || "—"}</div>
        <div className="text-[9px] text-white/45">{ageSec != null ? `${ageSec}s ago` : ""}</div>
      </Tile>

      {/* Symbol picker + date + refresh — inline right side */}
      <div className="flex items-center gap-1 border-l border-white/[0.06] pl-2">
        <div className="flex items-center gap-0.5">
          {SYMBOLS.map(s => (
            <button
              key={s}
              onClick={() => onSymbol(s)}
              className={`rounded-sm border px-1.5 py-1 text-[9px] font-bold uppercase tracking-wider transition-colors ${
                symbol === s
                  ? "border-sky-500 bg-sky-500/15 text-sky-300"
                  : "border-white/10 bg-white/[0.02] text-white/55 hover:bg-white/[0.05]"
              }`}
            >
              {s.replace("_", " ")}
            </button>
          ))}
        </div>
        <select
          value={date || ""}
          onChange={(e) => onDate(e.target.value || null)}
          className="ml-1 rounded-sm border border-white/10 bg-white/[0.03] px-1.5 py-1 text-[9px] text-white/75"
        >
          <option value="">— Live —</option>
          {availableDates.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="rounded-sm border border-sky-500/40 bg-sky-500/10 px-1.5 py-1 text-[9px] font-bold uppercase text-sky-300 hover:bg-sky-500/20 disabled:opacity-50"
        >
          {loading ? "..." : "↻"}
        </button>
      </div>
    </div>
  );
}

// Compact tile primitive
function Tile({ children, tone, className }: {
  children: React.ReactNode;
  tone?: "bull" | "bear" | "warn" | "neutral" | "info";
  className?: string;
}) {
  const t = tone ? V3_TONE[tone] : null;
  return (
    <div
      className={`flex flex-1 flex-col justify-center rounded-md border px-2 py-1 ${className || ""}`}
      style={{
        borderColor: t?.border ?? "rgba(255,255,255,0.08)",
        background: t?.soft ?? "#0e1117",
      }}
    >
      {children}
    </div>
  );
}

function Lbl({ text, icon, right }: { text: string; icon?: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-1">
      <span className="flex items-center gap-1 text-[8px] font-bold uppercase tracking-[0.14em] text-white/45">
        {icon ? <span className="text-[10px]">{icon}</span> : null}
        {text}
      </span>
      {right}
    </div>
  );
}
