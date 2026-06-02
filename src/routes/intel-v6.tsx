import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { isAuthenticated } from "@/lib/auth";
import { useIntelV6Decision } from "@/hooks/useIntelV6Decision";
import type { V6Symbol, V6Decision, V6ScaleRow, V6OpeningCol } from "@/lib/intelV6Types";

export const Route = createFileRoute("/intel-v6")({
  component: IntelV6Page,
});

/**
 * INTEL V6 — NIFTY MASTER ENGINE DASHBOARD
 * ========================================================================
 * GREEKS + CPR + BREADTH + IT ENGINE → one institutional master verdict.
 *   1. Market Breadth Engine
 *   2. IT Sector Strength Engine
 *   3. CPR Engine (width · levels · location · opening map · relation · trend)
 *   4. Greeks Engine (ATM) + market reading
 *   5. Complete Logic Matrix
 *   6. Final Verdict + Trade Plan
 */
function IntelV6Page() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!isAuthenticated()) navigate({ to: "/login" });
  }, [navigate]);

  const [symbol, setSymbol] = useState<V6Symbol>("NIFTY_50");
  const [date, setDate] = useState<string | null>(null);
  const { data, loading, lastFetchAt, refetch } = useIntelV6Decision({ symbol, date, intervalMs: 3000 });

  return (
    <div className="intelv6-root fixed inset-0 left-16 flex flex-col bg-black font-sans text-white">
      <header className="flex items-center justify-between border-b border-white/10 bg-[#05070b] px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="text-[15px] font-bold tracking-[0.18em] text-emerald-400">
            INTEL <span className="rounded-sm bg-emerald-400/15 px-1.5 py-0.5 text-[13px]">V6</span>
          </span>
          <span className="text-[12px] uppercase tracking-[0.16em] text-white/50">Master Engine Dashboard</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md bg-white/[0.05] p-0.5">
            {(["NIFTY_50", "SENSEX"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSymbol(s)}
                className={`rounded px-3 py-1 text-[13px] font-bold tracking-wider transition-colors ${
                  symbol === s ? "bg-sky-500/20 text-sky-300" : "text-white/55 hover:text-white"
                }`}
              >
                {s === "NIFTY_50" ? "NIFTY" : "SENSEX"}
              </button>
            ))}
          </div>
          <input
            type="date"
            value={date || todayIST()}
            max={todayIST()}
            onChange={(e) => setDate(e.target.value === todayIST() ? null : e.target.value)}
            className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[13px] text-white/85 outline-none [color-scheme:dark]"
          />
          <button
            onClick={() => setDate(null)}
            className={`rounded px-2 py-1 text-[12px] font-bold tracking-wider ${!date ? "bg-emerald-500/20 text-emerald-400" : "bg-white/5 text-white/55"}`}
          >
            LIVE
          </button>
          <button onClick={() => refetch()} disabled={loading} className="rounded-md border border-white/10 bg-white/[0.04] px-3 py-1 text-[13px] text-white/65">
            {loading ? "…" : "↻"}
          </button>
          <span className="text-[12px] text-white/45">{lastFetchAt ? `${Math.round((Date.now() - lastFetchAt) / 1000)}s` : "—"}</span>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
        {!data ? (
          <div className="flex h-full items-center justify-center text-[16px] text-white/45">Loading Master Engine…</div>
        ) : !data.ok ? (
          <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-6 text-rose-300">
            <div className="text-[15px] font-bold uppercase tracking-wider">Engine Error</div>
            <div className="mt-2 text-[14px]">{(data as unknown as { error?: string }).error || "Unable to load."}</div>
          </div>
        ) : (
          <MasterDashboard data={data} />
        )}
      </main>
    </div>
  );
}

/* ─── tone → color ──────────────────────────────────────────────────── */
const TONE: Record<string, string> = {
  strongbull: "#16c784",
  bull: "#22c55e",
  neutral: "#eab308",
  bear: "#f97316",
  strongbear: "#ef4444",
};
function tc(t: string): string {
  return TONE[t] || (t === "BULLISH" ? "#22c55e" : t === "BEARISH" ? "#ef4444" : "#eab308");
}

/* ═══════════════════════════════════════════════════════════════════════
 * MASTER DASHBOARD — grid matching the reference image.
 * ═══════════════════════════════════════════════════════════════════════ */
function MasterDashboard({ data }: { data: V6Decision }) {
  return (
    <div className="flex w-full flex-col gap-2 pb-2">
      <TitleBar data={data} />

      {/* Row A: Breadth | IT Sector | CPR | CPR Relationship + Trend View */}
      <div className="grid grid-cols-12 items-stretch gap-2">
        <div className="col-span-3"><BreadthEngine data={data} /></div>
        <div className="col-span-3"><ItEngine data={data} /></div>
        <div className="col-span-3"><CprEngine data={data} /></div>
        <div className="col-span-3 flex flex-col gap-2">
          <div className="shrink-0"><CprRelationship data={data} /></div>
          <div className="min-h-0 flex-1"><TrendView data={data} /></div>
        </div>
      </div>

      {/* Row B: Greeks Engine (ATM) + Greeks Market Reading */}
      <GreeksEngine data={data} />

      {/* Row C: Complete Logic Matrix | Final Verdict */}
      <div className="grid grid-cols-12 items-stretch gap-2">
        <div className="col-span-7"><LogicMatrix data={data} /></div>
        <div className="col-span-5"><FinalVerdict data={data} /></div>
      </div>

      <GoldenRule data={data} />
    </div>
  );
}

/* ── Panel shell ─────────────────────────────────────────────────────── */
function Panel({ title, accent = "#1e3a5f", children }: { title?: string; accent?: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col rounded border border-white/15 bg-[#0a0f17]">
      {title ? (
        <div className="rounded-t px-2 py-1.5 text-center text-[14px] font-bold uppercase tracking-[0.08em] text-cyan-300"
          style={{ background: accent }}>
          {title}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">{children}</div>
    </div>
  );
}

/* ═══════════════ TITLE BAR ════════════════════════════════════════════ */
function TitleBar({ data }: { data: V6Decision }) {
  const h = data.header;
  const chgTone = h.change >= 0 ? "#22c55e" : "#ef4444";
  const vixTone = h.vixChangePct <= 0 ? "#22c55e" : "#ef4444";
  const mode = h.marketMode;
  const modeTone = mode.state === "RISK ON" ? "#22c55e" : mode.state === "RISK OFF" ? "#ef4444" : "#eab308";
  return (
    <div className="grid grid-cols-12 items-stretch gap-2">
      {/* date / time */}
      <div className="col-span-2 flex flex-col justify-center rounded border border-white/15 bg-[#0a0f17] px-3 py-2">
        <span className="text-[13px] tracking-wide text-white/60">DATE : <span className="text-white/85">{h.date}</span></span>
        <span className="text-[13px] tracking-wide text-white/60">TIME : <span className="text-white/85">{h.time}</span></span>
      </div>

      {/* title + index quote */}
      <div className="col-span-7 flex flex-col items-center justify-center rounded border border-white/15 bg-[#0a0f17] px-2 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[22px] font-black tracking-wide text-white">NIFTY MASTER ENGINE DASHBOARD</span>
          <span className="text-[14px] font-bold tracking-wide text-cyan-300">( GREEKS + CPR + BREADTH + IT ENGINE )</span>
        </div>
        <div className="mt-1 flex items-center gap-3 rounded bg-black/40 px-4 py-1">
          <span className="text-[15px] font-bold text-white/80">{h.indexName}</span>
          <span className="font-mono text-[19px] font-black text-emerald-400">{h.spot.toLocaleString()}</span>
          <span className="font-mono text-[15px] font-bold" style={{ color: chgTone }}>
            {h.change >= 0 ? "+" : ""}{h.change.toFixed(2)} ({h.changePct >= 0 ? "+" : ""}{h.changePct.toFixed(2)}%)
          </span>
          <span className="ml-2 text-[15px] font-bold text-white/55">VIX</span>
          <span className="font-mono text-[16px] font-bold text-white/85">{h.vix.toFixed(2)}</span>
          <span className="font-mono text-[14px] font-bold" style={{ color: vixTone }}>
            ({h.vixChangePct >= 0 ? "+" : ""}{h.vixChangePct.toFixed(2)}%)
          </span>
        </div>
      </div>

      {/* market mode */}
      <div className="col-span-3 flex items-center justify-center gap-3 rounded border-2 bg-[#0a0f17] px-3 py-2"
        style={{ borderColor: `${modeTone}66` }}>
        <div className="flex flex-col items-center">
          <span className="text-[13px] font-bold uppercase tracking-wide text-white/55">Market Mode</span>
          <span className="text-[17px] font-black uppercase tracking-wide text-white/90">{mode.label}</span>
          <span className="text-[17px] font-black uppercase tracking-wide" style={{ color: modeTone }}>{mode.state}</span>
        </div>
        <span className="text-[30px]">{mode.bias === "BULLISH" ? "🐂" : mode.bias === "BEARISH" ? "🐻" : "•"}</span>
      </div>
    </div>
  );
}

/* ── Shared scale table (range → label rows, highlights the active one) ─ */
function ScaleTable({ rows }: { rows: V6ScaleRow[] }) {
  return (
    <div className="flex flex-col gap-1">
      {rows.map((r, i) => {
        const color = tc(r.tone);
        return (
          <div
            key={i}
            className="flex items-center justify-between rounded px-2 py-1 text-[13px]"
            style={{
              background: r.active ? `${color}26` : "transparent",
              border: `1px solid ${r.active ? `${color}88` : "rgba(255,255,255,0.07)"}`,
            }}
          >
            <span className="text-white/65">{r.range}</span>
            <span className="font-bold uppercase tracking-wide" style={{ color: r.active ? color : "rgba(255,255,255,0.45)" }}>
              {r.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════ 1. MARKET BREADTH ENGINE ═════════════════════════════ */
function BreadthEngine({ data }: { data: V6Decision }) {
  const b = data.breadthEngine;
  const color = tc(b.tone);
  return (
    <Panel title="1. MARKET BREADTH ENGINE">
      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat label="ADVANCING STOCKS" value={b.advancing} tone="#22c55e" />
        <Stat label="DECLINING STOCKS" value={b.declining} tone="#ef4444" />
        <Stat label="UNCHANGED STOCKS" value={b.unchanged} tone="#94a3b8" />
      </div>
      <div className="my-2 text-center text-[13px] text-white/65">
        BREADTH % = {b.formula}
      </div>
      <div className="grid grid-cols-[150px_1fr] items-center gap-3">
        <Gauge pct={b.pct} color={color} label={b.zone} />
        <ScaleTable rows={b.scale} />
      </div>
    </Panel>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone: string }) {
  return (
    <div className="rounded border border-white/10 bg-white/[0.02] px-2 py-2">
      <div className="text-[11px] font-bold uppercase leading-tight tracking-wide text-white/55">{label}</div>
      <div className="font-mono text-[26px] font-black leading-none" style={{ color: tone }}>{value}</div>
    </div>
  );
}

/* half-circle gauge with big % + zone label below */
function Gauge({ pct, color, label }: { pct: number; color: string; label: string }) {
  const v = Math.max(0, Math.min(100, pct));
  const R = 40, cx = 50, cy = 48;
  const a0 = Math.PI, a1 = 0;
  const ang = a0 + (a1 - a0) * (v / 100);
  const pt = (a: number, r: number) => ({ x: cx + r * Math.cos(a), y: cy - r * Math.sin(a) });
  const arc = (s: number, e: number, r: number) => {
    const p0 = pt(s, r), p1 = pt(e, r);
    const large = Math.abs(e - s) > Math.PI ? 1 : 0;
    const sweep = e < s ? 1 : 0;
    return `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${large} ${sweep} ${p1.x} ${p1.y}`;
  };
  return (
    <div className="flex flex-col items-center">
      <div className="relative h-[70px] w-[130px]">
        <svg viewBox="0 0 100 52" className="h-full w-full">
          <path d={arc(a0, a1, R)} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="8" strokeLinecap="round" />
          <path d={arc(a0, ang, R)} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 3px ${color})`, transition: "all .5s ease" }} />
        </svg>
        <div className="absolute inset-x-0 bottom-0 text-center">
          <span className="font-mono text-[26px] font-black" style={{ color }}>{v}%</span>
        </div>
      </div>
      <span className="mt-1 text-center text-[14px] font-black uppercase leading-tight tracking-wide" style={{ color }}>{label}</span>
    </div>
  );
}

/* ═══════════════ 2. IT SECTOR STRENGTH ENGINE ═════════════════════════ */
function ItEngine({ data }: { data: V6Decision }) {
  const it = data.itEngine;
  const color = tc(it.tone);
  return (
    <Panel title="2. IT SECTOR STRENGTH ENGINE">
      <div className="mb-2 flex items-center justify-between rounded border border-white/10 bg-white/[0.02] px-3 py-2">
        <span className="text-[16px] font-bold uppercase tracking-wide text-white/70">NIFTY IT</span>
        <span className="flex items-center gap-1 font-mono text-[26px] font-black" style={{ color }}>
          {it.changePct >= 0 ? "+" : ""}{it.changePct}% {it.changePct >= 0 ? "↑" : "↓"}
        </span>
      </div>
      <ScaleTable rows={it.scale} />
      <div className="mt-2 rounded border px-2 py-2 text-center text-[16px] font-black uppercase tracking-wide"
        style={{ borderColor: `${tc(it.bias)}66`, background: `${tc(it.bias)}1a`, color: tc(it.bias) }}>
        {it.summary}
      </div>
    </Panel>
  );
}

/* ═══════════════ 3. CPR ENGINE ════════════════════════════════════════ */
function CprEngine({ data }: { data: V6Decision }) {
  const c = data.cprEngine;
  const widthTone = tc(c.width.tone);
  const locTone = tc(c.locationBias);
  const lv = c.levels;
  return (
    <Panel title="3. CPR ENGINE">
      <div className="grid grid-cols-3 gap-1.5">
        {/* CPR WIDTH */}
        <div className="flex flex-col items-center rounded border border-white/10 bg-white/[0.02] px-1.5 py-1.5">
          <span className="text-[11px] font-bold uppercase tracking-wide text-white/50">CPR WIDTH</span>
          <span className="text-[18px] font-black uppercase" style={{ color: widthTone }}>{c.width.label}</span>
          <span className="mt-0.5 text-center text-[11px] leading-tight text-white/55">{c.width.headline}</span>
          <span className="text-center text-[11px] font-bold leading-tight" style={{ color: widthTone }}>{c.width.sub}</span>
        </div>
        {/* CPR LEVELS */}
        <div className="flex flex-col justify-center rounded border border-white/10 bg-white/[0.02] px-1.5 py-1.5">
          <span className="mb-1 text-center text-[11px] font-bold uppercase tracking-wide text-white/50">CPR LEVELS</span>
          <LevelRow k="R3" v={lv.r3} />
          <LevelRow k="TC (R2)" v={lv.tc} hl="#22c55e" />
          <LevelRow k="PIVOT" v={lv.pivot} hl="#eab308" />
          <LevelRow k="BC (S2)" v={lv.bc} hl="#f97316" />
          <LevelRow k="S3" v={lv.s3} />
        </div>
        {/* PRICE LOCATION */}
        <div className="flex flex-col items-center justify-center rounded border border-white/10 bg-white/[0.02] px-1.5 py-1.5">
          <span className="text-[11px] font-bold uppercase tracking-wide text-white/50">PRICE LOCATION</span>
          <span className="mt-1 text-[17px] font-black uppercase leading-tight" style={{ color: locTone }}>{c.priceLocation}</span>
          <span className="mt-1 text-center text-[12px] font-bold uppercase leading-tight" style={{ color: locTone }}>{c.territory}</span>
          <span className="text-center text-[11px] leading-tight text-white/55">{c.locationSub}</span>
        </div>
      </div>

      {/* location banner */}
      <div className="my-1.5 rounded border px-2 py-1.5 text-center text-[14px] font-black uppercase tracking-wide"
        style={{ borderColor: `${locTone}66`, background: `${locTone}1a`, color: locTone }}>
        {c.locationBanner}
      </div>

      {/* OPENING SCENARIO ENGINE */}
      <div className="rounded border border-white/10 bg-black/30 p-1.5">
        <div className="mb-1.5 text-center text-[12px] font-bold uppercase tracking-[0.12em] text-cyan-300">Opening Scenario Engine</div>
        <div className="grid grid-cols-3 gap-1.5">
          <OpeningCol head="GAP UP OPEN" cols={c.opening.gapUp} />
          <OpeningCol head="FLAT OPEN" cols={c.opening.flat} />
          <OpeningCol head="GAP DOWN OPEN" cols={c.opening.gapDown} />
        </div>
      </div>
    </Panel>
  );
}

function LevelRow({ k, v, hl }: { k: string; v: number; hl?: string }) {
  return (
    <div className="flex items-center justify-between text-[12px] leading-snug">
      <span className="text-white/55">{k}</span>
      <span className="font-mono font-bold" style={{ color: hl || "rgba(255,255,255,0.85)" }}>
        {v ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—"}
      </span>
    </div>
  );
}

function OpeningCol({ head, cols }: { head: string; cols: V6OpeningCol[] }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-center text-[11px] font-bold uppercase tracking-wide text-white/55">{head}</span>
      {cols.map((o, i) => {
        const color = tc(o.tone);
        return (
          <div key={i} className="rounded border px-1.5 py-1 text-center"
            style={{ borderColor: o.active ? `${color}99` : "rgba(255,255,255,0.1)", background: o.active ? `${color}1f` : "transparent" }}>
            <div className="text-[11px] font-bold uppercase" style={{ color: o.active ? color : "rgba(255,255,255,0.6)" }}>{o.cond}</div>
            <div className="text-[10px] leading-tight text-white/65">{o.verdict}</div>
            <div className="text-[10px] leading-tight text-white/45">{o.sub}</div>
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════ CPR RELATIONSHIP ═════════════════════════════════════ */
function CprRelationship({ data }: { data: V6Decision }) {
  const r = data.cprEngine.relation;
  const color = tc(r.bias);
  return (
    <Panel title="CPR RELATIONSHIP" accent="#3a2a5f">
      <div className="flex flex-1 flex-col items-center justify-center py-2">
        <span className="text-[20px] font-black uppercase tracking-wide" style={{ color }}>{r.label}</span>
        <span className="mt-1.5 text-[14px] font-bold uppercase text-white/70">{r.l1}</span>
        <span className="text-[14px] uppercase text-white/55">{r.l2}</span>
      </div>
    </Panel>
  );
}

/* ═══════════════ MARKET TREND VIEW ════════════════════════════════════ */
function TrendView({ data }: { data: V6Decision }) {
  const tv = data.trendView;
  return (
    <Panel title="MARKET TREND VIEW" accent="#1e3a5f">
      <div className="flex flex-1 flex-col justify-between gap-2">
        {tv.rows.map((row, i) => {
          const color = tc(row.tone);
          const arrow = row.dir === "UP" ? "⬆" : row.dir === "DOWN" ? "⬇" : "⊖";
          return (
            <div key={i} className="flex shrink-0 items-center gap-3 rounded border px-2 py-2"
              style={{ borderColor: row.active ? `${color}88` : "rgba(255,255,255,0.08)", background: row.active ? `${color}18` : "transparent" }}>
              <span className="text-[24px] leading-none" style={{ color: row.active ? color : "rgba(255,255,255,0.35)" }}>{arrow}</span>
              <div className="flex flex-col">
                <span className="text-[15px] font-black uppercase tracking-wide" style={{ color: row.active ? color : "rgba(255,255,255,0.55)" }}>{row.label}</span>
                <span className="text-[12px] leading-tight text-white/55">{row.l1} · {row.l2}</span>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/* ═══════════════ 4. GREEKS ENGINE (ATM) ═══════════════════════════════ */
function GreeksEngine({ data }: { data: V6Decision }) {
  const g = data.greeksEngine;
  return (
    <Panel title="4. GREEKS ENGINE ( ATM )">
      <div className="grid h-full grid-cols-12 gap-2">
        <div className="col-span-2"><GreekCard name="DELTA" value={fmtSigned(g.delta.value, 2)} trend={g.delta.trend} sub={g.delta.control} subTone={tc(g.delta.bias)} scale={g.delta.scale} /></div>
        <div className="col-span-2"><GreekCard name="GAMMA" value={fmtSigned(g.gamma.value, 3)} trend={g.gamma.trend} sub={g.gamma.state} subTone="#22c55e" scale={g.gamma.scale} /></div>
        <div className="col-span-2"><GreekCard name="VEGA" value={fmtSigned(g.vega.value, 3)} trend={g.vega.trend} sub={g.vega.state} subTone="#22c55e" scale={g.vega.scale} /></div>
        <div className="col-span-2"><GreekCard name="THETA" value={fmtSigned(g.theta.value, 3)} trend={g.theta.trend} sub={`${g.theta.decay} · ${g.theta.friendly}`} subTone={g.theta.friendly === "BUYER EDGE" || g.theta.friendly === "BUYER FRIENDLY" ? "#22c55e" : g.theta.decay === "HIGH DECAY" ? "#ef4444" : "#eab308"} scale={g.theta.scale} /></div>
        <div className="col-span-4"><GreeksReading data={data} /></div>
      </div>
    </Panel>
  );
}

function GreekCard({
  name, value, trend, sub, subTone, scale,
}: {
  name: string; value: string; trend: string; sub: string; subTone: string; scale: V6ScaleRow[];
}) {
  const trendUp = trend === "RISING";
  const trendDown = trend === "FALLING";
  const valTone = name === "THETA" ? "#ef4444" : "#22c55e";
  return (
    <div className="flex h-full flex-col rounded border border-white/12 bg-white/[0.02] p-2">
      <div className="text-center text-[14px] font-black uppercase tracking-wide text-white/75">{name}</div>
      <div className="flex items-center justify-center gap-1">
        <span className="font-mono text-[28px] font-black leading-none" style={{ color: valTone }}>{value}</span>
        <span className="text-[20px]" style={{ color: trendUp ? "#22c55e" : trendDown ? "#ef4444" : "#94a3b8" }}>
          {trendUp ? "⬆" : trendDown ? "⬇" : "→"}
        </span>
      </div>
      <div className="text-center text-[12px] font-bold uppercase leading-tight" style={{ color: trendUp ? "#22c55e" : trendDown ? "#ef4444" : "#94a3b8" }}>
        {trend}
      </div>
      <div className="mb-1.5 text-center text-[11px] font-bold uppercase leading-tight" style={{ color: subTone }}>{sub}</div>
      <ScaleTable rows={scale} />
    </div>
  );
}

function GreeksReading({ data }: { data: V6Decision }) {
  const rows = data.greeksEngine.reading;
  return (
    <div className="flex h-full flex-col rounded border border-white/12 bg-white/[0.02] p-2">
      <div className="mb-2 text-center text-[14px] font-black uppercase tracking-[0.10em] text-cyan-300">Greeks Market Reading</div>
      <div className="flex flex-1 flex-col justify-around gap-1.5">
        {rows.map((r, i) => {
          const color = tc(r.tone);
          const [left, right] = splitReading(r.text);
          return (
            <div key={i} className="flex items-center justify-between rounded px-2 py-1.5 text-[12px]"
              style={{ background: r.active ? `${color}1f` : "rgba(255,255,255,0.02)", border: `1px solid ${r.active ? `${color}77` : "rgba(255,255,255,0.06)"}` }}>
              <span className="text-white/70">{left}</span>
              <span className="font-bold uppercase" style={{ color }}>{right}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
function splitReading(text: string): [string, string] {
  const idx = text.indexOf("=");
  if (idx < 0) return [text, ""];
  return [text.slice(0, idx + 1), text.slice(idx + 1).trim()];
}

/* ═══════════════ 5. COMPLETE LOGIC MATRIX ═════════════════════════════ */
function LogicMatrix({ data }: { data: V6Decision }) {
  const lm = data.logicMatrix;
  const condTone = tc(lm.conditionBias);
  return (
    <Panel title="5. COMPLETE LOGIC MATRIX ( FINAL VIEW )">
      <div className="grid h-full grid-cols-[1fr_auto] gap-3">
        {/* left: engine rows */}
        <div className="flex flex-1 flex-col justify-around gap-1">
          {lm.rows.map((row, i) => {
            const color = tc(row.tone);
            return (
              <div key={i} className="grid grid-cols-[120px_1fr_auto] items-center gap-2 rounded px-2 py-1.5 text-[13px]"
                style={{ background: "rgba(255,255,255,0.02)" }}>
                <span className="font-bold uppercase tracking-wide text-white/60">{row.engine}</span>
                <span className={`font-mono ${row.greeks ? "text-[11px]" : ""} font-bold`} style={{ color }}>{row.value}</span>
                <span className="text-right font-bold uppercase" style={{ color }}>{row.verdict}</span>
              </div>
            );
          })}
          <div className="mt-1 rounded border px-2 py-1.5 text-center text-[14px] font-black uppercase tracking-wide"
            style={{ borderColor: `${condTone}66`, background: `${condTone}1a`, color: condTone }}>
            MARKET CONDITION : {lm.condition}
          </div>
        </div>

        {/* right: logic summary checklist */}
        <div className="flex w-[230px] flex-col justify-center rounded border border-white/10 bg-black/30 p-2">
          <span className="mb-2 text-center text-[13px] font-bold uppercase tracking-wide text-white/55">Logic Summary</span>
          {lm.summary.map((s, i) => (
            <div key={i} className="flex items-center gap-2 py-0.5 text-[13px]">
              <span className="text-[15px]" style={{ color: s.ok ? "#22c55e" : "#64748b" }}>{s.ok ? "✔" : "○"}</span>
              <span className="uppercase" style={{ color: s.ok ? "rgba(255,255,255,0.8)" : "rgba(255,255,255,0.4)" }}>{s.label}</span>
            </div>
          ))}
          <div className="mt-2 rounded px-2 py-1 text-center text-[13px] font-black uppercase tracking-wide"
            style={{ background: lm.allAlign ? "#22c55e22" : "#eab30822", color: lm.allAlign ? "#22c55e" : "#eab308" }}>
            {lm.alignText}
          </div>
        </div>
      </div>
    </Panel>
  );
}

/* ═══════════════ 6. FINAL VERDICT ═════════════════════════════════════ */
function FinalVerdict({ data }: { data: V6Decision }) {
  const fv = data.finalVerdict;
  const color = tc(fv.bias);
  return (
    <Panel title="6. FINAL VERDICT">
      <div className="flex h-full flex-col justify-around">
        <div className="text-center font-black uppercase leading-none tracking-wide"
          style={{ color, fontSize: 48, textShadow: `0 0 16px ${color}44` }}>
          {fv.setup}
        </div>
        <div className="my-2 flex items-center justify-center gap-2">
          <Stars value={fv.stars} />
          <span className="ml-2 text-[15px] font-bold uppercase text-white/70">Confidence Level :</span>
          <span className="font-mono text-[18px] font-black" style={{ color }}>{fv.confidenceText}</span>
        </div>

        <div className="grid grid-cols-4 gap-2">
          {fv.cells.map((c, i) => {
            const cTone = tc(c.tone);
            const arrow = c.icon === "up" ? "⬆" : c.icon === "down" ? "⬇" : c.label === "MOMENTUM" ? "📈" : c.label === "MARKET MODE" ? "🐂" : "";
            return (
              <div key={i} className="flex flex-col items-center rounded border border-white/10 bg-white/[0.02] px-1.5 py-2">
                <span className="text-[12px] font-bold uppercase tracking-wide text-white/50">{c.label}</span>
                <span className="text-[17px] font-black uppercase" style={{ color: cTone }}>{c.value}</span>
                {arrow ? <span className="text-[16px]" style={{ color: cTone }}>{arrow}</span> : null}
              </div>
            );
          })}
        </div>

        <div className="mt-2 flex items-center justify-center gap-3 rounded border px-3 py-2.5"
          style={{ borderColor: `${color}66`, background: `${color}14` }}>
          <span className="text-[15px] font-bold uppercase tracking-wide text-white/70">TRADE PLAN :</span>
          <span className="text-[19px] font-black uppercase tracking-wide" style={{ color }}>{fv.tradePlan}</span>
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 text-[13px] text-black">✓</span>
        </div>
      </div>
    </Panel>
  );
}

function Stars({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className="text-[24px] leading-none" style={{ color: i < value ? "#22c55e" : "rgba(255,255,255,0.2)" }}>★</span>
      ))}
    </div>
  );
}

/* ═══════════════ GOLDEN RULE ══════════════════════════════════════════ */
function GoldenRule({ data }: { data: V6Decision }) {
  return (
    <div className="rounded border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-center">
      <span className="text-[13px] font-black uppercase tracking-[0.10em] text-amber-300">GOLDEN RULE : </span>
      <span className="text-[13px] uppercase tracking-wide text-white/70">{data.goldenRule}</span>
    </div>
  );
}

/* ─── helpers ─────────────────────────────────────────────────────── */
function fmtSigned(n: number, d: number): string {
  const v = Number(n.toFixed(d));
  return `${v >= 0 ? "+" : ""}${v}`;
}
function todayIST(): string {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
}
