import type { IntelV2Snapshot, IntelV2Symbol } from "@/lib/intelV2Types";
import { Activity, Calendar, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { v2Fmt, v2FmtSigned, V2Pill } from "./common";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";

interface TopHeaderV2Props {
  data: IntelV2Snapshot | null;
  symbol: IntelV2Symbol;
  onSymbol: (s: IntelV2Symbol) => void;
  date: string | null;
  onDate: (d: string | null) => void;
  availableDates: string[];
  loading?: boolean;
  lastFetchAt?: number | null;
  onRefresh?: () => void | Promise<void>;
}

function todayIST(): string {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
}

function secondsAgo(now: Date, ts: number): number {
  return Math.max(0, Math.floor((now.getTime() - ts) / 1000));
}

export function TopHeaderV2({
  data, symbol, onSymbol, date, onDate, availableDates,
  loading = false, lastFetchAt = null, onRefresh,
}: TopHeaderV2Props) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const istTime = now.toLocaleTimeString("en-IN", { hour12: false });

  const spotChange = data?.spot.change ?? 0;
  const spotPct = data?.spot.changePct ?? 0;

  const fut = data?.futures.ltp ?? 0;
  const futChange = (fut && data?.spot.priorClose) ? Number((fut - data.spot.priorClose).toFixed(2)) : 0;
  const futPct = (data?.spot.priorClose && futChange) ? Number(((futChange / data.spot.priorClose) * 100).toFixed(2)) : 0;

  const showLive = !date;
  const allDates = (() => {
    const set = new Set([...availableDates, todayIST()]);
    return [...set].sort();
  })();
  const idx = date ? allDates.indexOf(date) : allDates.length - 1;
  const canPrev = idx > 0;
  const canNext = idx >= 0 && idx < allDates.length - 1;

  const goPrev = () => {
    if (idx > 0) {
      const nd = allDates[idx - 1];
      onDate(nd === todayIST() ? null : nd);
    }
  };
  const goNext = () => {
    if (idx < allDates.length - 1) {
      const nd = allDates[idx + 1];
      onDate(nd === todayIST() ? null : nd);
    }
  };
  const goLive = () => onDate(null);

  return (
    <div className="flex h-16 shrink-0 items-center justify-between border-b border-white/[0.06] bg-[#0a0d12] px-4">
      {/* LEFT — Logo + Symbol toggle */}
      <div className="flex items-center gap-5">
        <div className="flex items-center gap-2">
          <Activity className="text-emerald-400" size={24} />
          <div>
            <div className="text-[14px] font-bold tracking-wider text-emerald-400">
              INTEL <span className="rounded-sm bg-emerald-400/15 px-1.5 py-0.5 text-[11px] tracking-wider">V2</span>
            </div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">
              Institutional Console
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 rounded-md bg-white/[0.04] p-0.5">
          {(["NIFTY_50", "SENSEX"] as const).map((s) => (
            <button
              key={s}
              onClick={() => onSymbol(s)}
              className={cn(
                "rounded px-3.5 py-1.5 text-[12px] font-bold tracking-wide transition-colors",
                symbol === s
                  ? "bg-sky-500/20 text-sky-300"
                  : "text-white/55 hover:text-white/85",
              )}
            >
              {s === "NIFTY_50" ? "NIFTY" : "SENSEX"}
            </button>
          ))}
        </div>
      </div>

      {/* CENTER — Spot / Fut / Premium / VIX */}
      <div className="flex items-center gap-8">
        <Quote
          label="Spot"
          value={v2Fmt(data?.spot.ltp, 2)}
          changeAbs={spotChange}
          changePct={spotPct}
          live={!!data?.spot.live}
        />
        <Quote
          label={symbol === "SENSEX" ? "Sensex Fut" : "Nifty Fut"}
          value={v2Fmt(fut, 2)}
          changeAbs={futChange}
          changePct={futPct}
        />
        <Quote
          label="Premium / Disc"
          value={v2Fmt(data?.futures.premium, 2)}
          tone={(data?.futures.premium ?? 0) >= 0 ? "bull" : "bear"}
          subText={(data?.futures.premium ?? 0) >= 0 ? "Premium" : "Discount"}
        />
        <Quote
          label="India VIX"
          value={v2Fmt(data?.dashboard?.ivAnalytics?.vix, 2)}
          changePct={data?.dashboard?.ivAnalytics?.vixChangePct ?? null}
        />
      </div>

      {/* RIGHT — Date picker, refresh, time, status */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1 rounded-md border border-white/[0.07] bg-white/[0.03] px-2 py-1.5">
          <button
            onClick={goPrev}
            disabled={!canPrev}
            className="rounded p-0.5 text-white/65 hover:bg-white/10 hover:text-white disabled:opacity-30"
            title="Previous day"
          >
            <ChevronLeft size={15} />
          </button>
          <Calendar size={13} className="text-white/55" />
          <input
            type="date"
            value={date || todayIST()}
            max={todayIST()}
            onChange={(e) => {
              const v = e.target.value;
              onDate(v === todayIST() ? null : v);
            }}
            className="bg-transparent text-[12px] font-mono text-white/85 outline-none [color-scheme:dark]"
          />
          <button
            onClick={goNext}
            disabled={!canNext}
            className="rounded p-0.5 text-white/65 hover:bg-white/10 hover:text-white disabled:opacity-30"
            title="Next day"
          >
            <ChevronRight size={15} />
          </button>
          <button
            onClick={goLive}
            className={cn(
              "ml-1 rounded px-2 py-1 text-[11px] font-bold tracking-wider",
              showLive ? "bg-emerald-500/20 text-emerald-400" : "bg-white/5 text-white/55 hover:text-white",
            )}
          >
            LIVE
          </button>
        </div>

        {/* Refresh button + last-updated indicator */}
        <div className="flex items-center gap-1.5 rounded-md border border-white/[0.07] bg-white/[0.03] px-2 py-1.5">
          <button
            onClick={() => onRefresh?.()}
            disabled={loading}
            className={cn(
              "rounded p-0.5 transition-colors",
              loading ? "text-emerald-300" : "text-white/65 hover:bg-white/10 hover:text-white",
              "disabled:opacity-60",
            )}
            title="Refresh now"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
          <span className="font-mono text-[10px] text-white/55 min-w-[58px] text-center">
            {lastFetchAt ? `${secondsAgo(now, lastFetchAt)}s ago` : "—"}
          </span>
          <V2Pill
            label={showLive ? "AUTO 3s" : "STATIC"}
            tone={showLive ? "bull" : "neutral"}
            size="xs"
          />
        </div>

        <div className="flex flex-col items-end">
          <V2Pill
            label={data?.market.isOpen ? "OPEN" : "CLOSED"}
            tone={data?.market.isOpen ? "bull" : "bear"}
            size="sm"
          />
          <div className="font-mono text-[11px] text-white/65 mt-0.5">{istTime}</div>
        </div>
      </div>
    </div>
  );
}

function Quote({
  label, value, changeAbs, changePct, tone, subText, live,
}: {
  label: string;
  value: string;
  changeAbs?: number | null;
  changePct?: number | null;
  tone?: "bull" | "bear" | "neutral";
  subText?: string;
  live?: boolean;
}) {
  const c = changeAbs ?? changePct ?? 0;
  const positive = c >= 0;
  const tColor = tone === "bull" ? "text-emerald-400"
    : tone === "bear" ? "text-rose-400"
    : positive ? "text-emerald-400" : "text-rose-400";
  return (
    <div className="flex flex-col items-center">
      <span className="flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-white/55">
        {label}
        {live ? (
          <span
            className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(34,197,94,0.8)]"
            title="Live WebSocket tick"
          />
        ) : null}
      </span>
      <span className="font-mono text-[18px] font-bold text-white">{value}</span>
      <span className={cn("font-mono text-[11px]", tColor)}>
        {changeAbs != null ? v2FmtSigned(changeAbs, 2) : ""}
        {changePct != null ? ` (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)` : ""}
        {subText ? ` ${subText}` : ""}
      </span>
    </div>
  );
}
