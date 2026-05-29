import type { IntelV2Snapshot, IntelV2Symbol } from "@/lib/intelV2Types";
import { Activity, Calendar, ChevronLeft, ChevronRight, Clock, Lock, RefreshCw } from "lucide-react";
import { V2Pill } from "./common";
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
    <div className="relative flex h-16 shrink-0 items-center justify-between border-b border-white/[0.06] bg-[#0a0d12] px-4">
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

      {/* CENTER — Date · Status · State · Time as styled icon tiles
          (absolutely positioned so the cluster is centered against the
          full header width regardless of how wide LEFT/RIGHT clusters are). */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="pointer-events-auto flex items-center gap-3">
        <CenterTile
          tone="info"
          icon={<Calendar size={18} />}
          label="DATE"
        >
          <div className="flex items-center gap-1">
            <button
              onClick={goPrev}
              disabled={!canPrev}
              className="rounded p-0.5 text-sky-300/65 hover:text-sky-300 disabled:opacity-30"
              title="Previous day"
            >
              <ChevronLeft size={14} />
            </button>
            <input
              type="date"
              value={date || todayIST()}
              max={todayIST()}
              onChange={(e) => {
                const v = e.target.value;
                onDate(v === todayIST() ? null : v);
              }}
              className="bg-transparent text-[13px] font-mono font-bold text-sky-200 outline-none [color-scheme:dark]"
            />
            <button
              onClick={goNext}
              disabled={!canNext}
              className="rounded p-0.5 text-sky-300/65 hover:text-sky-300 disabled:opacity-30"
              title="Next day"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </CenterTile>

        <CenterTile
          tone={showLive ? "bull" : "neutral"}
          icon={<Activity size={18} />}
          label="STATUS"
        >
          <button
            onClick={goLive}
            className={cn(
              "rounded-md border px-3 py-1 text-[12px] font-black tracking-[0.18em]",
              showLive
                ? "border-emerald-400/60 bg-emerald-400/15 text-emerald-300 shadow-[0_0_12px_rgba(34,197,94,0.35)]"
                : "border-white/15 bg-white/5 text-white/55 hover:text-white",
            )}
            title={showLive ? "Auto-refresh enabled" : "Click to go live"}
          >
            {showLive ? "LIVE" : "STATIC"}
          </button>
        </CenterTile>

        <CenterTile
          tone={data?.market.isOpen ? "bull" : "bear"}
          icon={data?.market.isOpen ? <Activity size={18} /> : <Lock size={16} />}
          label="STATE"
        >
          <span
            className={cn(
              "rounded-md border px-3 py-1 text-[12px] font-black tracking-[0.18em]",
              data?.market.isOpen
                ? "border-emerald-400/60 bg-emerald-400/15 text-emerald-300 shadow-[0_0_12px_rgba(34,197,94,0.35)]"
                : "border-rose-400/60 bg-rose-400/15 text-rose-300 shadow-[0_0_12px_rgba(239,68,68,0.30)]",
            )}
          >
            {data?.market.isOpen ? "OPEN" : "CLOSED"}
          </span>
        </CenterTile>

        <CenterTile
          tone="purple"
          icon={<Clock size={18} />}
          label="TIME"
        >
          <span className="font-mono text-[14px] font-bold tabular-nums text-purple-200">
            {istTime}
          </span>
        </CenterTile>
        </div>
      </div>

      {/* RIGHT — Refresh + last-updated */}
      <div className="flex items-center gap-3">
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
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * CenterTile — neon-style header card with icon + label + content.
 * Matches the user's reference image: rounded box with a glowing icon
 * at top, ALL-CAPS label below, action/value at the bottom.
 * ───────────────────────────────────────────────────────────────────── */
function CenterTile({
  tone, icon, label, children,
}: {
  tone: "info" | "bull" | "bear" | "warn" | "neutral" | "purple";
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  const palette = {
    info:    { color: "#38bdf8", bg: "rgba(56,189,248,0.10)",  border: "rgba(56,189,248,0.40)",  glow: "0 0 14px rgba(56,189,248,0.25)" },
    bull:    { color: "#22c55e", bg: "rgba(34,197,94,0.10)",   border: "rgba(34,197,94,0.40)",   glow: "0 0 14px rgba(34,197,94,0.25)"  },
    bear:    { color: "#ef4444", bg: "rgba(239,68,68,0.10)",   border: "rgba(239,68,68,0.40)",   glow: "0 0 14px rgba(239,68,68,0.25)"  },
    warn:    { color: "#f59e0b", bg: "rgba(245,158,11,0.10)",  border: "rgba(245,158,11,0.40)",  glow: "0 0 14px rgba(245,158,11,0.25)" },
    neutral: { color: "#9ca3af", bg: "rgba(156,163,175,0.08)", border: "rgba(156,163,175,0.30)", glow: "none" },
    purple:  { color: "#a855f7", bg: "rgba(168,85,247,0.10)",  border: "rgba(168,85,247,0.40)",  glow: "0 0 14px rgba(168,85,247,0.25)" },
  } as const;
  const p = palette[tone];
  return (
    <div
      className="flex flex-col items-center justify-center gap-1 rounded-md border px-3 py-1.5"
      style={{ borderColor: p.border, background: p.bg, boxShadow: p.glow }}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="flex h-5 w-5 items-center justify-center rounded-full"
          style={{ background: `${p.color}22`, color: p.color }}
        >
          {icon}
        </span>
        <span
          className="text-[10px] font-bold uppercase tracking-[0.18em]"
          style={{ color: p.color }}
        >
          {label}
        </span>
      </div>
      <div className="flex items-center justify-center">{children}</div>
    </div>
  );
}

