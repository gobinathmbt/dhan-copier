import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { isAuthenticated } from "@/lib/auth";
import { useStrikeTable } from "@/hooks/useStrikeTable";
import type { StrikeSymbol, StrikeTableResponse, StrikeRow } from "@/lib/strikeTableTypes";

export const Route = createFileRoute("/strike-table")({
  component: StrikeTablePage,
});

/**
 * STRIKE TABLE
 * ========================================================================
 * Primary (ATM) strike of the day with ± 6 strikes, each row carrying:
 *   • Live CE/PE LTP (live tick when market is open, recorded snapshot otherwise)
 *   • First-5-min CE/PE high & low (the opening-range)
 *   • OI · Volume
 * ATM row is highlighted; CE laid out left of the strike, PE on the right.
 */
function StrikeTablePage() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!isAuthenticated()) navigate({ to: "/login" });
  }, [navigate]);

  const [symbol, setSymbol] = useState<StrikeSymbol>("NIFTY_50");
  const [date, setDate] = useState<string | null>(null);
  const [range, setRange] = useState<number>(3);
  const [show50, setShow50] = useState<boolean>(false);
  // First 5-min ORB never changes after 09:20 — fetch once, no polling.
  const { data, loading, lastFetchAt, refetch } = useStrikeTable({ symbol, date, range, intervalMs: 0 });

  // Round-strike filter: when show50 is OFF, drop strikes that are not
  // multiples of 100 from the rendered table (purely a view filter — the
  // backend still returns the natural step ladder). The ATM row is
  // always kept even if it lands on a 50-step (e.g., NIFTY ATM 23350)
  // so the table never loses its focal row.
  const viewData = useMemo<StrikeTableResponse | null>(() => {
    if (!data || !data.ok) return data;
    if (show50) return data;
    const filteredRows = (data.rows || []).filter(
      (r) => r.isAtm || Number(r.strike) % 100 === 0,
    );
    return { ...data, rows: filteredRows, rowCount: filteredRows.length };
  }, [data, show50]);

  return (
    <div className="strike-table-root fixed inset-0 left-3 flex flex-col bg-[#06090e] font-sans text-white">
      <header className="flex items-center justify-between border-b border-white/10 bg-[#0a0e15] px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="text-[15px] font-bold tracking-[0.16em] text-amber-300">STRIKE TABLE</span>
          <span className="text-[12px] uppercase tracking-[0.16em] text-white/50">
            ATM ± {range} · First 5-min Range
          </span>
          {data?.ok ? (
            <span
              className="rounded px-2 py-0.5 text-[10px] font-black uppercase tracking-wide"
              style={{
                background: data.source === "live" ? "#22c55e1a" : "#64748b1a",
                border: `1px solid ${data.source === "live" ? "#22c55e66" : "#64748b66"}`,
                color: data.source === "live" ? "#22c55e" : "#94a3b8",
              }}
            >
              {data.source === "live" ? "● LIVE" : "FOLDER"}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[12px] text-white/75 hover:bg-white/[0.08]">
            <input
              type="checkbox"
              checked={show50}
              onChange={(e) => setShow50(e.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer accent-amber-400"
            />
            <span className="font-bold uppercase tracking-wider">50 Strikes</span>
          </label>
          <div className="flex rounded-md bg-white/[0.05] p-0.5">
            {(["NIFTY_50", "SENSEX"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSymbol(s)}
                className={`rounded px-3 py-1 text-[13px] font-bold tracking-wider transition-colors ${
                  symbol === s ? "bg-amber-500/20 text-amber-300" : "text-white/55 hover:text-white"
                }`}
              >
                {s === "NIFTY_50" ? "NIFTY" : "SENSEX"}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[12px] text-white/65">
            <span className="font-bold uppercase tracking-wider text-white/50">Strikes</span>
            <select
              value={range}
              onChange={(e) => setRange(Number(e.target.value))}
              className="bg-transparent text-[13px] font-bold text-amber-300 outline-none [color-scheme:dark]"
            >
              {[1, 2, 3, 4, 5, 6, 8, 10].map((n) => (
                <option key={n} value={n} className="bg-[#0a0e15] text-white">
                  ± {n}
                </option>
              ))}
            </select>
          </label>
          <input
            type="date"
            value={date || todayIST()}
            max={todayIST()}
            onChange={(e) => setDate(e.target.value === todayIST() ? null : e.target.value)}
            className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[13px] text-white/85 outline-none [color-scheme:dark]"
          />
          <button
            onClick={() => setDate(null)}
            className={`rounded px-2 py-1 text-[12px] font-bold tracking-wider ${
              !date ? "bg-emerald-500/20 text-emerald-400" : "bg-white/5 text-white/55"
            }`}
          >
            LIVE
          </button>
          <button
            onClick={() => refetch()}
            disabled={loading}
            className="rounded-md border border-white/10 bg-white/[0.04] px-3 py-1 text-[13px] text-white/65"
          >
            {loading ? "…" : "↻ Refresh"}
          </button>
          <span className="text-[11px] text-white/45">
            {lastFetchAt ? `${Math.round((Date.now() - lastFetchAt) / 1000)}s` : "—"}
          </span>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
        {!viewData ? (
          <div className="flex h-full items-center justify-center text-[16px] text-white/45">
            Loading strike table…
          </div>
        ) : !viewData.ok ? (
          <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-6 text-rose-300">
            <div className="text-[15px] font-bold uppercase tracking-wider">Error</div>
            <div className="mt-2 text-[14px]">
              {viewData.error || "Unable to load strike data."}
            </div>
          </div>
        ) : (
          <StrikeTableView data={viewData} />
        )}
      </main>
    </div>
  );
}

function todayIST(): string {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
}

/* ═══════════════════════════════════════════════════════════════════════
 * STRIKE TABLE VIEW
 * ═══════════════════════════════════════════════════════════════════════ */
function StrikeTableView({ data }: { data: StrikeTableResponse }) {
  return (
    <div className="flex w-full flex-col gap-3">
      <SummaryBar data={data} />
      <Table data={data} />
      {!data.fiveMin.ready ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/[0.06] px-3 py-2 text-center text-[12px] text-amber-200">
          First-5-min option chain not yet available for {data.date} — high/low cells will populate once the opening window has been recorded.
        </div>
      ) : null}
    </div>
  );
}

/* ── Top summary bar — date · spot · ATM · 5-min window meta ────────── */
function SummaryBar({ data }: { data: StrikeTableResponse }) {
  const chgTone = data.spotChange >= 0 ? "#22c55e" : "#ef4444";
  const winLabel = data.fiveMin.windowStartMs
    ? formatIstTimeRange(data.fiveMin.windowStartMs, data.fiveMin.windowEndMs)
    : "—";
  return (
    <div className="grid grid-cols-1 gap-2 lg:grid-cols-5">
      <Stat label="Symbol" value={data.displayName} />
      <Stat label="Date" value={data.date} sub={data.isToday ? "TODAY" : "HISTORICAL"} />
      <Stat
        label="Spot"
        value={data.spot.toLocaleString()}
        sub={`${data.spotChange >= 0 ? "+" : ""}${data.spotChange.toFixed(2)} (${data.spotChangePct >= 0 ? "+" : ""}${data.spotChangePct.toFixed(2)}%)`}
        subTone={chgTone}
      />
      <Stat label="ATM" value={`${data.atm}`} sub={`Step ${data.step} · ${data.rowCount} rows`} />
      <Stat
        label="First 5-min Window"
        value={winLabel}
        sub={`${data.fiveMin.snapshotCount} snapshots`}
        subTone={data.fiveMin.ready ? "#22c55e" : "#eab308"}
      />
    </div>
  );
}

function Stat({ label, value, sub, subTone }: { label: string; value: string; sub?: string; subTone?: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-[#0a0e15] px-3 py-2">
      <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/45">{label}</div>
      <div className="font-mono text-[16px] font-black text-white/95">{value}</div>
      {sub ? (
        <div className="text-[11px] font-bold uppercase tracking-wide" style={{ color: subTone || "rgba(255,255,255,0.55)" }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

/* ── Strike grid — each strike is a column (CE top · PE bottom) ─────── */
function Table({ data }: { data: StrikeTableResponse }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState(false);

  // On first render (or whenever the symbol/date changes), scroll the ATM
  // column into view (centered).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setOverflow(el.scrollWidth > el.clientWidth + 1);
    const atmCol = el.querySelector<HTMLElement>('[data-atm="true"]');
    if (atmCol) {
      const target = atmCol.offsetLeft - el.clientWidth / 2 + atmCol.offsetWidth / 2;
      el.scrollTo({ left: Math.max(0, target), behavior: "auto" });
    }
  }, [data.symbol, data.date, data.atm, data.range, data.rowCount]);

  // Update overflow flag on resize
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      setOverflow(el.scrollWidth > el.clientWidth + 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scrollBy = (dx: number) => {
    scrollRef.current?.scrollBy({ left: dx, behavior: "smooth" });
  };

  // Column min-width so each cell stays readable.
  const COL_MIN = 200;

  return (
    <div className="relative w-full">
      {/* scroll arrows (only when content overflows) */}
      {overflow ? (
        <>
          <button
            onClick={() => scrollBy(-480)}
            className="absolute left-2 top-1/2 z-20 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-black/70 text-[18px] text-white/75 backdrop-blur transition-colors hover:bg-black/85"
            aria-label="Scroll left"
          >
            ‹
          </button>
          <button
            onClick={() => scrollBy(480)}
            className="absolute right-2 top-1/2 z-20 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-black/70 text-[18px] text-white/75 backdrop-blur transition-colors hover:bg-black/85"
            aria-label="Scroll right"
          >
            ›
          </button>
        </>
      ) : null}

      {/* horizontal scroller */}
      <div
        ref={scrollRef}
        className="overflow-x-auto rounded-xl border border-white/10 bg-[#0a0e15]"
        style={{ scrollBehavior: "smooth" }}
      >
        <div
          className="flex"
          style={{
            // When columns fit, stretch them to fill the container & center.
            // When they overflow, keep min-width so cell text stays legible.
            minWidth: "100%",
            justifyContent: overflow ? "flex-start" : "center",
          }}
        >
          {data.rows.map((row) => (
            <StrikeColumn key={row.strike} row={row} minWidth={COL_MIN} grow={!overflow} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ColHeader({
  side, isAtm, tag, strike,
}: {
  side: "CE" | "PE";
  isAtm: boolean;
  tag: string;
  strike: number;
}) {
  const isCe = side === "CE";
  // Light-blue band for CE, light-pink for PE — matches the institutional look.
  const bg = isCe ? "bg-sky-500/[0.18]" : "bg-rose-500/[0.18]";
  const fg = isCe ? "text-sky-100" : "text-rose-100";
  return (
    <div
      className={`flex h-10 items-center justify-center border-b border-r border-white/10 text-[13px] font-black uppercase tracking-[0.10em] ${bg} ${fg} ${
        isAtm ? "ring-1 ring-amber-300/70" : ""
      }`}
    >
      {side} {isAtm ? "(ATM)" : tag} {strike}
    </div>
  );
}
function StrikeColumn({ row, minWidth, grow }: { row: StrikeRow; minWidth: number; grow: boolean }) {
  const ce = row.ce;
  const pe = row.pe;
  const isAtm = row.isAtm;
  // CE is ITM when strike < spot (offset < 0), PE is ITM when strike > spot
  const ceItm = row.offset < 0;
  const peItm = row.offset > 0;
  const ceTag = isAtm ? "(ATM)" : ceItm ? "ITM" : "OTM";
  const peTag = isAtm ? "(ATM)" : peItm ? "ITM" : "OTM";

  return (
    <div
      data-atm={isAtm ? "true" : undefined}
      className="flex shrink-0 flex-col"
      style={{
        minWidth,
        flex: grow ? "1 1 0" : "0 0 auto",
        boxShadow: isAtm ? "inset 0 0 0 2px rgba(56,189,248,0.85)" : undefined,
      }}
    >
      {/* CE header */}
      <ColHeader side="CE" isAtm={isAtm} tag={ceTag} strike={row.strike} />
      {/* CE HIGH / LOW */}
      <CellRow
        kind="ce"
        open={ce.firstFiveOpen}
        high={ce.firstFiveHigh}
        low={ce.firstFiveLow}
        ltp={ce.ltp}
        itm={ceItm}
      />
      {/* PE header */}
      <ColHeader side="PE" isAtm={isAtm} tag={peTag} strike={row.strike} />
      {/* PE HIGH / LOW */}
      <CellRow
        kind="pe"
        open={pe.firstFiveOpen}
        high={pe.firstFiveHigh}
        low={pe.firstFiveLow}
        ltp={pe.ltp}
        itm={peItm}
      />
    </div>
  );
}

function CellRow({
  kind, high, low, ltp, itm,
}: {
  kind: "ce" | "pe";
  open: number | null;
  high: number | null;
  low: number | null;
  ltp: number;
  itm: boolean;
}) {
  return (
    <div className="grid h-12 grid-cols-2 border-b border-r border-white/10">
      <Cell label="HIGH" value={fmtNum(high)} tone="high" />
      <Cell label="LOW" value={fmtNum(low)} tone="low" />
      {/* Hidden helper — keep LTP for hover/title for reference */}
      <span className="sr-only">{`${kind.toUpperCase()} LTP ${ltp} · ${itm ? "ITM" : "OTM"}`}</span>
    </div>
  );
}

function Cell({
  label, value, tone,
}: {
  label: string;
  value: string;
  tone: "high" | "low";
}) {
  // High = light green, Low = light red — same vibe across CE & PE rows.
  const bg = tone === "high" ? "bg-emerald-500/[0.18]" : "bg-rose-500/[0.18]";
  const fg = tone === "high" ? "text-emerald-200" : "text-rose-200";
  const dot = tone === "high" ? "text-emerald-400" : "text-rose-400";
  return (
    <div
      className={`flex items-center justify-center gap-1.5 border-r border-white/10 ${bg} px-2`}
      title={label}
    >
      <span className={`text-[10px] font-black uppercase tracking-[0.16em] ${dot}`}>{label}</span>
      <span className={`font-mono text-[15px] font-black tabular-nums ${fg}`}>
        {value}
      </span>
    </div>
  );
}

/* ─── helpers ─────────────────────────────────────────────────────── */
function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return "—";
  return n.toFixed(2);
}
function formatIstTimeRange(startMs: number, endMs: number | null): string {
  const istOffset = 5.5 * 3600 * 1000;
  const fmt = (ms: number) => {
    const d = new Date(ms + istOffset);
    let h = d.getUTCHours();
    const m = d.getUTCMinutes();
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12; if (h === 0) h = 12;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} ${ampm}`;
  };
  return endMs ? `${fmt(startMs)} → ${fmt(endMs)}` : fmt(startMs);
}
