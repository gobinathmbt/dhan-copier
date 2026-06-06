import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { isAuthenticated } from "@/lib/auth";
import { useOrderFlow } from "@/hooks/useOrderFlow";
import type {
  OFSymbol, OrderFlowResponse, OFCard, OFFlowAlignmentRow,
} from "@/lib/orderFlowTypes";

export const Route = createFileRoute("/order-flow")({
  component: OrderFlowPage,
});

/**
 * ORDER FLOW INTEL ENGINE — Side-View Logic Dashboard
 * ======================================================================
 * Independent dashboard answering: WHO IS ATTACKING · WHO IS ABSORBING ·
 * WHO IS TRAPPED · WHO IS WINNING — plus a per-strike (ATM ± 6 round 100)
 * BUY CE / BUY PE / WAIT decision and a reversal-probability sub-engine.
 */
function OrderFlowPage() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!isAuthenticated()) navigate({ to: "/login" });
  }, [navigate]);

  const [symbol, setSymbol] = useState<OFSymbol>("NIFTY_50");
  const [date, setDate] = useState<string | null>(null);
  const { data, loading, lastFetchAt, refetch } = useOrderFlow({
    symbol, date, intervalMs: date ? 0 : 3000,
  });

  return (
    <div className="orderflow-root fixed inset-0 left-3 flex flex-col bg-[#06090e] font-sans text-white">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#0a0e15] px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="text-[15px] font-bold tracking-[0.18em] text-amber-300">
            ORDER FLOW <span className="rounded-sm bg-amber-400/15 px-1.5 py-0.5 text-[12px]">INTEL</span>
          </span>
          <span className="text-[12px] uppercase tracking-[0.16em] text-white/55">
            SIDE VIEW LOGIC DASHBOARD
          </span>
          <span className="hidden text-[12px] uppercase tracking-[0.12em] text-white/45 md:inline">
            <span className="text-emerald-300">WHO IS ATTACKING?</span>{" · "}
            <span className="text-amber-300">WHO IS ABSORBING?</span>{" · "}
            <span className="text-rose-300">WHO IS TRAPPED?</span>{" · "}
            <span className="text-cyan-300">WHO IS WINNING?</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
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
          >LIVE</button>
          <button onClick={() => refetch()} disabled={loading}
            className="rounded-md border border-white/10 bg-white/[0.04] px-3 py-1 text-[13px] text-white/65">
            {loading ? "…" : "↻"}
          </button>
          <span className="text-[11px] text-white/45">
            {lastFetchAt ? `${Math.round((Date.now() - lastFetchAt) / 1000)}s` : "—"}
          </span>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
        {!data ? (
          <div className="flex h-full items-center justify-center text-[16px] text-white/45">
            Loading Order Flow Intel Engine…
          </div>
        ) : !data.ok ? (
          <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-6 text-rose-300">
            <div className="text-[15px] font-bold uppercase tracking-wider">Engine Error</div>
            <div className="mt-2 text-[14px]">{data.error || "Unable to load order flow."}</div>
          </div>
        ) : (
          <Dashboard data={data} />
        )}
      </main>
    </div>
  );
}

function todayIST(): string {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
}

/* ─── tone → color ───────────────────────────────────────────────── */
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
function fmtVol(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}
function fmtSigned(n: number): string {
  return `${n >= 0 ? "+" : ""}${fmtVol(n)}`;
}


/* ═════════════════════════════════════════════════════════════════════
 *  DASHBOARD — top-to-bottom layout matching the reference image
 * ═════════════════════════════════════════════════════════════════════ */
function Dashboard({ data }: { data: OrderFlowResponse }) {
  return (
    <div className="flex flex-col gap-2 pb-2">
      <TitleBar data={data} />

      {/* Cards 1-5 row */}
      <div className="grid grid-cols-12 gap-2">
        <div className="col-span-3"><AggressionCard data={data} /></div>
        <div className="col-span-2"><DeltaCard data={data} /></div>
        <div className="col-span-3"><AbsorptionCard data={data} /></div>
        <div className="col-span-2"><ExhaustionCard data={data} /></div>
        <div className="col-span-2"><TrapCard data={data} /></div>
      </div>

      {/* Cards 6-8 row */}
      <div className="grid grid-cols-12 gap-2">
        <div className="col-span-4"><PremiumAcceptanceCard data={data} /></div>
        <div className="col-span-4"><FlowAlignmentMatrix data={data} /></div>
        <div className="col-span-4"><InstitutionalFootprint data={data} /></div>
      </div>

      {/* Score Engine row + Verdict + Golden Connection */}
      <div className="grid grid-cols-12 gap-2">
        <div className="col-span-4"><ScoreEngineCard data={data} /></div>
        <div className="col-span-4"><VerdictEngineCard data={data} /></div>
        <div className="col-span-4"><GoldenConnectionCard data={data} /></div>
      </div>

      {/* Reversal probability + Per-strike decision grid */}
      <ReversalCard data={data} />
      <PerStrikeGrid data={data} />

      {/* Footer — How to use + Example logic */}
      <FooterStrip data={data} />
    </div>
  );
}

/* ═══════════════ TITLE BAR ═══════════════════════════════════════════ */
function TitleBar({ data }: { data: OrderFlowResponse }) {
  const color = tc(data.tone);
  return (
    <div className="grid grid-cols-12 items-stretch gap-2 rounded border border-white/15 bg-[#0a0f17] px-3 py-2">
      <div className="col-span-2 flex flex-col justify-center">
        <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-white/55">DATE · TIME</span>
        <span className="font-mono text-[14px] font-black text-white/85">{data.date}</span>
        <span className="text-[11px] text-white/55">{new Date(data.at).toLocaleTimeString()}</span>
      </div>
      <div className="col-span-5 flex flex-col items-center justify-center">
        <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-white/55">{data.displayName}</span>
        <span className="font-mono text-[24px] font-black text-emerald-400">{data.spot.toLocaleString()}</span>
        <span className="font-mono text-[12px] font-bold"
          style={{ color: data.spotChange >= 0 ? "#22c55e" : "#ef4444" }}>
          {data.spotChange >= 0 ? "+" : ""}{data.spotChange.toFixed(2)}{" "}
          ({data.spotChangePct >= 0 ? "+" : ""}{data.spotChangePct.toFixed(2)}%)
        </span>
      </div>
      <div className="col-span-3 flex items-center justify-center gap-2 rounded border px-2 py-1"
        style={{ borderColor: `${color}66`, background: `${color}14` }}>
        <span className="text-[11px] font-bold uppercase tracking-wide text-white/55">ORDER FLOW SCORE</span>
        <span className="font-mono text-[34px] font-black leading-none" style={{ color }}>{data.score}</span>
        <span className="text-[14px] font-black uppercase" style={{ color }}>{data.state}</span>
      </div>
      <div className="col-span-2 flex flex-col items-end justify-center">
        <span className="text-[11px] uppercase text-white/55">SOURCE</span>
        <span className="text-[12px] font-black uppercase"
          style={{ color: data.source === "live" ? "#22c55e" : "#94a3b8" }}>
          {data.source === "live" ? "● LIVE" : "FOLDER"}
        </span>
        <span className="text-[10px] uppercase text-white/45">
          ATM {data.atm} · STEP {data.step}
        </span>
      </div>
    </div>
  );
}

/* ═══════════════ Card shell ══════════════════════════════════════════ */
function Card({
  num, title, sub, tone, children,
}: {
  num: string; title: string; sub?: string; tone?: string; children: React.ReactNode;
}) {
  const color = tone ? tc(tone) : "#3b82f6";
  return (
    <div className="flex h-full flex-col rounded border border-white/15 bg-[#0a0f17]">
      <div className="flex items-center gap-2 border-b border-white/10 px-2 py-1.5"
        style={{ background: `${color}10` }}>
        <span className="rounded bg-white/10 px-1.5 py-0.5 text-[11px] font-bold text-cyan-300">{num}</span>
        <span className="text-[13px] font-black uppercase tracking-wide text-white/85">{title}</span>
        {sub ? <span className="ml-auto text-[10px] uppercase tracking-wide text-white/45">{sub}</span> : null}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-2">{children}</div>
    </div>
  );
}

function VerdictBanner({ verdict, tone }: { verdict: string; tone: string }) {
  const color = tc(tone);
  const arrow = tone === "bull" || tone === "strongbull" ? "⬆" : tone === "bear" || tone === "strongbear" ? "⬇" : "—";
  return (
    <div className="mt-auto flex items-center justify-between rounded border px-2 py-1"
      style={{ borderColor: `${color}66`, background: `${color}14` }}>
      <span className="text-[10px] font-bold uppercase tracking-wide text-white/55">VERDICT</span>
      <span className="flex items-center gap-1 text-[12px] font-black uppercase tracking-wide" style={{ color }}>
        <span>{arrow}</span><span>{verdict}</span>
      </span>
    </div>
  );
}


/* ═══════════════ 1. AGGRESSION CARD ═══════════════════════════════════ */
function AggressionCard({ data }: { data: OrderFlowResponse }) {
  const a = data.aggression;
  return (
    <Card num="1" title="AGGRESSION CARD" sub="BUY VS SELL AGGRESSION" tone={a.tone}>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-[10px] font-bold uppercase text-white/45">MARKET BUY VOL</div>
          <div className="font-mono text-[18px] font-black text-emerald-400">{fmtVol(a.buyVol)}</div>
        </div>
        <div className="flex flex-col items-end">
          <div className="text-[10px] font-bold uppercase text-white/45">MARKET SELL VOL</div>
          <div className="font-mono text-[18px] font-black text-rose-400">{fmtVol(a.sellVol)}</div>
        </div>
      </div>
      <Donut value={a.side === "SELLERS" ? a.sellDomPct : a.buyDomPct}
        color={a.side === "SELLERS" ? "#ef4444" : "#22c55e"}
        label={`${a.side === "SELLERS" ? "SELL" : "BUY"} DOMINANT`} />
      <VerdictBanner verdict={a.verdict} tone={a.tone} />
    </Card>
  );
}

function Donut({ value, color, label }: { value: number; color: string; label: string }) {
  const r = 32, c = 2 * Math.PI * r;
  const off = c - (value / 100) * c;
  return (
    <div className="flex items-center justify-center gap-2">
      <svg viewBox="0 0 80 80" className="h-[70px] w-[70px]">
        <circle cx="40" cy="40" r={r} stroke="rgba(255,255,255,0.12)" strokeWidth="10" fill="none" />
        <circle cx="40" cy="40" r={r} stroke={color} strokeWidth="10" fill="none"
          strokeDasharray={c} strokeDashoffset={off} strokeLinecap="round"
          transform="rotate(-90 40 40)" style={{ transition: "stroke-dashoffset .5s" }} />
        <text x="40" y="44" textAnchor="middle" className="font-mono"
          style={{ fill: color, fontSize: 18, fontWeight: 900 }}>{value}%</text>
      </svg>
      <span className="text-[11px] font-black uppercase tracking-wide" style={{ color }}>{label}</span>
    </div>
  );
}

/* ═══════════════ 2. DELTA CARD ═══════════════════════════════════════ */
function DeltaCard({ data }: { data: OrderFlowResponse }) {
  const d = data.delta;
  const color = d.value >= 0 ? "#22c55e" : "#ef4444";
  return (
    <Card num="2" title="DELTA CARD" sub="NET DELTA" tone={d.tone}>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-[10px] font-bold uppercase text-white/45">BUY VOLUME</div>
          <div className="font-mono text-[14px] font-black text-emerald-400">{fmtVol(d.buyVol)}</div>
        </div>
        <div className="flex flex-col items-end">
          <div className="text-[10px] font-bold uppercase text-white/45">SELL VOLUME</div>
          <div className="font-mono text-[14px] font-black text-rose-400">{fmtVol(d.sellVol)}</div>
        </div>
      </div>
      <div className="flex flex-col items-center py-1">
        <span className="font-mono text-[26px] font-black leading-none" style={{ color }}>
          {fmtSigned(d.value)}
        </span>
        <span className="text-[10px] uppercase text-white/55">DELTA · {d.pct >= 0 ? "+" : ""}{d.pct.toFixed(1)}%</span>
      </div>
      <VerdictBanner verdict={d.verdict} tone={d.tone} />
    </Card>
  );
}

/* ═══════════════ 3. ABSORPTION DETECTOR ══════════════════════════════ */
function AbsorptionCard({ data }: { data: OrderFlowResponse }) {
  const a = data.absorption;
  return (
    <Card num="3" title="ABSORPTION DETECTOR" sub="HIDDEN INTEREST" tone={a.tone}>
      <div className="flex flex-col gap-1 text-[11px]">
        <AbsorptionRow
          label="PRICE UP" delta="DELTA POSITIVE" right="SELLER ABSORPTION"
          active={a.state === "SELLER ABSORPTION"} tone="bear" />
        <div className="text-center text-[10px] uppercase text-white/45">PRICE NOT MOVING</div>
        <AbsorptionRow
          label="PRICE DOWN" delta="DELTA NEGATIVE" right="BUYER ABSORPTION"
          active={a.state === "BUYER ABSORPTION"} tone="bull" />
      </div>
      <VerdictBanner verdict={a.verdict} tone={a.tone} />
    </Card>
  );
}
function AbsorptionRow({ label, delta, right, active, tone }: { label: string; delta: string; right: string; active: boolean; tone: string }) {
  const color = tc(tone);
  return (
    <div className="flex items-center justify-between rounded border px-2 py-1"
      style={{ borderColor: active ? `${color}88` : "rgba(255,255,255,0.08)", background: active ? `${color}14` : "transparent" }}>
      <div className="flex flex-col">
        <span className="text-[11px] font-black uppercase" style={{ color: active ? color : "rgba(255,255,255,0.55)" }}>{label} {tone === "bear" ? "↑" : "↓"}</span>
        <span className="text-[10px] uppercase" style={{ color: active ? color : "rgba(255,255,255,0.45)" }}>{delta}</span>
      </div>
      <span className="text-[12px] font-black uppercase" style={{ color }}>{right}</span>
    </div>
  );
}

/* ═══════════════ 4. EXHAUSTION DETECTOR ══════════════════════════════ */
function ExhaustionCard({ data }: { data: OrderFlowResponse }) {
  const e = data.exhaustion;
  return (
    <Card num="4" title="EXHAUSTION DETECTOR" sub="MOMENTUM EXHAUSTION" tone={e.tone}>
      <div className="grid grid-cols-2 gap-1 text-center">
        <div className="rounded border border-white/10 bg-white/[0.02] px-2 py-1.5">
          <div className="text-[10px] font-bold uppercase text-white/45">DELTA</div>
          <div className="text-[14px] font-black uppercase"
            style={{ color: e.tone === "bear" ? "#22c55e" : e.tone === "bull" ? "#ef4444" : "#94a3b8" }}>INCREASING</div>
        </div>
        <div className="rounded border border-white/10 bg-white/[0.02] px-2 py-1.5">
          <div className="text-[10px] font-bold uppercase text-white/45">PRICE</div>
          <div className="text-[12px] font-black uppercase text-amber-300">STOPS MOVING</div>
        </div>
      </div>
      <div className="rounded border px-2 py-1 text-center text-[12px] font-black uppercase"
        style={{ borderColor: `${tc(e.tone)}55`, background: `${tc(e.tone)}14`, color: tc(e.tone) }}>
        {e.state === "NONE" ? "MOMENTUM INTACT" : e.state}
      </div>
      <VerdictBanner verdict={e.verdict} tone={e.tone} />
    </Card>
  );
}

/* ═══════════════ 5. TRAP DETECTOR ════════════════════════════════════ */
function TrapCard({ data }: { data: OrderFlowResponse }) {
  const t = data.trap;
  return (
    <Card num="5" title="TRAP DETECTOR" sub="TRAP PROBABILITY" tone={t.tone}>
      <div className="flex flex-col gap-1 text-[10px]">
        <TrapRow label="AGGRESSIVE BUYERS ENTER" target="BUYER TRAP" pct={t.probabilityBuyer ?? 0}
          active={t.label === "BUYER TRAP"} tone="bear" />
        <TrapRow label="AGGRESSIVE SELLERS ENTER" target="SELLER TRAP" pct={t.probabilitySeller ?? 0}
          active={t.label === "SELLER TRAP"} tone="bull" />
      </div>
      <VerdictBanner verdict={t.verdict} tone={t.tone} />
    </Card>
  );
}
function TrapRow({ label, target, pct, active, tone }: { label: string; target: string; pct: number; active: boolean; tone: string }) {
  const color = tc(tone);
  return (
    <div className="flex items-center justify-between rounded border px-2 py-1"
      style={{ borderColor: active ? `${color}88` : "rgba(255,255,255,0.08)", background: active ? `${color}14` : "transparent" }}>
      <div className="flex flex-col">
        <span className="text-[10px] font-black uppercase" style={{ color: active ? color : "rgba(255,255,255,0.55)" }}>{label}</span>
        <span className="text-[10px] uppercase text-white/45">PRICE FAILS = {target}</span>
      </div>
      <span className="font-mono text-[16px] font-black" style={{ color }}>{pct}%</span>
    </div>
  );
}


/* ═══════════════ 6. PREMIUM ACCEPTANCE ═══════════════════════════════ */
function PremiumAcceptanceCard({ data }: { data: OrderFlowResponse }) {
  const p = data.premiumAccept;
  return (
    <Card num="6" title="PREMIUM ACCEPTANCE" sub="SPOT DELTA vs OPTION PREMIUM" tone={p.tone}>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-[10px] font-bold uppercase text-white/45">SPOT DELTA</div>
          <div className="font-mono text-[14px] font-black"
            style={{ color: (data.delta.value ?? 0) >= 0 ? "#22c55e" : "#ef4444" }}>
            {fmtSigned(data.delta.value)}
          </div>
          <div className="text-[9px] uppercase"
            style={{ color: (data.delta.value ?? 0) >= 0 ? "#22c55e" : "#ef4444" }}>
            {(data.delta.value ?? 0) >= 0 ? "BUYING PRESSURE" : "SELLING PRESSURE"}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-bold uppercase text-white/45">ATM CE Δ</div>
          <div className="font-mono text-[14px] font-black"
            style={{ color: (p.cePctMove ?? 0) >= 0 ? "#22c55e" : "#ef4444" }}>
            {(p.cePctMove ?? 0) >= 0 ? "+" : ""}{(p.cePctMove ?? 0).toFixed(2)}%
          </div>
          <div className="text-[9px] uppercase"
            style={{ color: (p.cePctMove ?? 0) >= 0 ? "#22c55e" : "#ef4444" }}>
            PREMIUM {(p.cePctMove ?? 0) >= 0 ? "RISING" : "FALLING"}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-bold uppercase text-white/45">ATM PE Δ</div>
          <div className="font-mono text-[14px] font-black"
            style={{ color: (p.pePctMove ?? 0) >= 0 ? "#22c55e" : "#ef4444" }}>
            {(p.pePctMove ?? 0) >= 0 ? "+" : ""}{(p.pePctMove ?? 0).toFixed(2)}%
          </div>
          <div className="text-[9px] uppercase"
            style={{ color: (p.pePctMove ?? 0) >= 0 ? "#22c55e" : "#ef4444" }}>
            PREMIUM {(p.pePctMove ?? 0) >= 0 ? "RISING" : "FALLING"}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded border px-2 py-1 text-center"
          style={{
            borderColor: p.state === "OPTION ACCEPTANCE" ? "#22c55e88" : "rgba(255,255,255,0.10)",
            background: p.state === "OPTION ACCEPTANCE" ? "#22c55e14" : "transparent",
          }}>
          <div className="text-[10px] font-bold uppercase text-emerald-300">SPOT BUYING<br />CE PREMIUM RISING</div>
          <div className="my-0.5 text-emerald-300">=</div>
          <div className="text-[12px] font-black uppercase text-emerald-300">OPTION ACCEPTANCE</div>
        </div>
        <div className="rounded border px-2 py-1 text-center"
          style={{
            borderColor: p.state === "NO ACCEPTANCE" ? "#ef444488" : "rgba(255,255,255,0.10)",
            background: p.state === "NO ACCEPTANCE" ? "#ef444414" : "transparent",
          }}>
          <div className="text-[10px] font-bold uppercase text-rose-300">SPOT BUYING<br />CE PREMIUM FLAT</div>
          <div className="my-0.5 text-rose-300">=</div>
          <div className="text-[12px] font-black uppercase text-rose-300">NO ACCEPTANCE</div>
        </div>
      </div>
      <VerdictBanner verdict={p.verdict} tone={p.tone} />
    </Card>
  );
}

/* ═══════════════ 7. FLOW ALIGNMENT MATRIX ════════════════════════════ */
function FlowAlignmentMatrix({ data }: { data: OrderFlowResponse }) {
  const f = data.flowAlignment;
  return (
    <Card num="7" title="FLOW ALIGNMENT MATRIX" sub="SPOT vs CE vs PE ALIGNMENT" tone={f.tone}>
      <div className="grid grid-cols-4 gap-1 rounded border border-white/10 bg-white/[0.02] px-2 py-1.5 text-center text-[10px] font-bold uppercase text-white/55">
        <span>SPOT</span><span>CE (ATM)</span><span>PE (ATM)</span><span>VERDICT</span>
      </div>
      <div className="flex flex-1 flex-col gap-0.5">
        {f.rows.map((r, i) => <FlowRow key={i} row={r} />)}
      </div>
      <div className="text-center text-[11px] text-white/55">{f.desc}</div>
    </Card>
  );
}
function FlowRow({ row }: { row: OFFlowAlignmentRow }) {
  const color = tc(row.tone);
  const arrow = (s: string, isPe?: boolean) => {
    // For the visual matrix, color CE/PE arrows by raw side; reverse for PE-bearish reading is in tone.
    const sideTone = s === "BUY" ? "#22c55e" : s === "SELL" ? "#ef4444" : "#94a3b8";
    const a = s === "BUY" ? "⬆" : s === "SELL" ? "⬇" : "—";
    void isPe;
    return <span style={{ color: sideTone }}>{a} {s}</span>;
  };
  return (
    <div className="grid grid-cols-4 items-center gap-1 rounded border px-2 py-1 text-[11px] font-bold uppercase"
      style={{ borderColor: row.active ? `${color}88` : "rgba(255,255,255,0.06)", background: row.active ? `${color}14` : "transparent" }}>
      {arrow(row.spot)}
      {arrow(row.ce)}
      {arrow(row.pe, true)}
      <span className="text-[12px] font-black uppercase" style={{ color }}>{row.verdict}</span>
    </div>
  );
}

/* ═══════════════ 8. INSTITUTIONAL FOOTPRINT ══════════════════════════ */
function InstitutionalFootprint({ data }: { data: OrderFlowResponse }) {
  const f = data.footprint;
  const color = tc(f.tone);
  return (
    <Card num="8" title="INSTITUTIONAL FOOTPRINT" sub="FRVP + DELTA + ABSORPTION" tone={f.tone}>
      <div className="grid grid-cols-4 gap-2 text-center">
        <FootCell label="FRVP LOCATION" big={data.auctionZone.replace(" VALUE", "")}
          sub={`POC ${data.poc ? Math.round(data.poc) : "—"}`} tone="neutral" />
        <FootCell label="DELTA TREND" big={f.deltaTrend ?? "FLAT"}
          sub={`Cum ${data.cumDelta >= 0 ? "+" : ""}${Math.round(data.cumDelta)}`}
          tone={f.deltaTrend === "RISING" ? "bull" : f.deltaTrend === "FALLING" ? "bear" : "neutral"} />
        <FootCell label="ABSORPTION SIGNAL" big={(data.absorption.state ?? "NONE").replace(" ABSORPTION", "")}
          sub={(data.absorption.state ?? "NONE") === "NONE" ? "—" : "AT KEY LEVEL"}
          tone={data.absorption.tone} />
        <FootCell label="INSTITUTIONAL ACTIVITY" big={f.activity ?? "—"}
          sub="" tone={f.tone} />
      </div>
      <div className="rounded border px-2 py-1.5 text-center text-[12px] font-black uppercase"
        style={{ borderColor: `${color}66`, background: `${color}14`, color }}>
        {f.signal}
      </div>
    </Card>
  );
}
function FootCell({ label, big, sub, tone }: { label: string; big: string; sub: string; tone: string }) {
  const color = tc(tone);
  return (
    <div className="rounded border border-white/10 bg-white/[0.02] px-1 py-1.5">
      <div className="text-[9px] font-bold uppercase text-white/45">{label}</div>
      <div className="text-[12px] font-black uppercase" style={{ color }}>{big}</div>
      {sub ? <div className="text-[9px] uppercase text-white/45">{sub}</div> : null}
    </div>
  );
}


/* ═══════════════ ORDER FLOW SCORE ENGINE ═════════════════════════════ */
function ScoreEngineCard({ data }: { data: OrderFlowResponse }) {
  const sb = data.scoreBreakdown;
  const rows = [
    { key: "Buyer Aggression",    score: sb.buyerAggression.score,    weight: sb.buyerAggression.weight,    color: "#22c55e" },
    { key: "Seller Absorption",   score: sb.sellerAbsorption.score,   weight: sb.sellerAbsorption.weight,   color: "#ef4444" },
    { key: "Premium Acceptance",  score: sb.premiumAcceptance.score,  weight: sb.premiumAcceptance.weight,  color: "#eab308" },
    { key: "Flow Alignment",      score: sb.flowAlignment.score,      weight: sb.flowAlignment.weight,      color: "#a855f7" },
  ];
  return (
    <Card num="" title="ORDER FLOW SCORE ENGINE" tone={data.tone}>
      <div className="grid grid-cols-[1fr_auto] items-center gap-3">
        <BigDonut value={data.weightedScore} color={tc(data.tone)} />
        <div className="flex flex-col gap-1">
          {rows.map((r) => (
            <div key={r.key} className="flex items-center gap-2 text-[11px]">
              <span className="h-2 w-2 rounded-sm" style={{ background: r.color }} />
              <span className="flex-1 uppercase tracking-wide text-white/65">{r.key}</span>
              <span className="font-mono text-white/55">{r.weight}%</span>
              <span className="font-mono font-black" style={{ color: r.color }}>{r.score}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-auto flex items-center justify-between rounded border border-white/10 bg-white/[0.02] px-2 py-1">
        <span className="text-[11px] font-bold uppercase text-white/55">WEIGHTED SCORE</span>
        <span className="font-mono text-[15px] font-black" style={{ color: tc(data.tone) }}>{data.weightedScore} / 100</span>
      </div>
    </Card>
  );
}
function BigDonut({ value, color }: { value: number; color: string }) {
  const r = 38, c = 2 * Math.PI * r;
  const off = c - (value / 100) * c;
  return (
    <svg viewBox="0 0 90 90" className="h-[100px] w-[100px]">
      <circle cx="45" cy="45" r={r} stroke="rgba(255,255,255,0.10)" strokeWidth="9" fill="none" />
      <circle cx="45" cy="45" r={r} stroke={color} strokeWidth="9" fill="none"
        strokeDasharray={c} strokeDashoffset={off} strokeLinecap="round"
        transform="rotate(-90 45 45)" style={{ transition: "stroke-dashoffset .5s" }} />
      <text x="45" y="44" textAnchor="middle" style={{ fill: color, fontSize: 22, fontWeight: 900 }} className="font-mono">{value}</text>
      <text x="45" y="60" textAnchor="middle" style={{ fill: "rgba(255,255,255,0.45)", fontSize: 9 }}>SCORE</text>
    </svg>
  );
}

/* ═══════════════ ORDER FLOW VERDICT ENGINE ═══════════════════════════ */
function VerdictEngineCard({ data }: { data: OrderFlowResponse }) {
  const tiers = [
    { range: "0-20",   label: "STRONG BEAR", tone: "strongbear", active: data.score < 20 },
    { range: "20-40",  label: "BEAR",         tone: "bear",       active: data.score >= 20 && data.score <= 40 },
    { range: "40-60",  label: "NEUTRAL",      tone: "neutral",    active: data.score > 40 && data.score < 60 },
    { range: "60-80",  label: "BULL",         tone: "bull",       active: data.score >= 60 && data.score < 80 },
    { range: "80-100", label: "STRONG BULL",  tone: "strongbull", active: data.score >= 80 },
  ];
  return (
    <Card num="" title="ORDER FLOW VERDICT ENGINE" tone={data.tone}>
      <div className="grid grid-cols-5 gap-1">
        {tiers.map((t) => {
          const c = tc(t.tone);
          return (
            <div key={t.range} className="flex flex-col items-center rounded border px-1 py-1.5"
              style={{ borderColor: t.active ? `${c}99` : "rgba(255,255,255,0.10)", background: t.active ? `${c}1a` : "transparent" }}>
              <span className="text-[10px] font-bold" style={{ color: t.active ? c : "rgba(255,255,255,0.45)" }}>{t.range}</span>
              <span className="text-[11px] font-black uppercase leading-tight"
                style={{ color: t.active ? c : "rgba(255,255,255,0.55)" }}>{t.label}</span>
            </div>
          );
        })}
      </div>
      <div className="rounded border px-3 py-2"
        style={{ borderColor: `${tc(data.tone)}66`, background: `${tc(data.tone)}14` }}>
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-[10px] font-bold uppercase text-white/55">CURRENT VERDICT</div>
            <div className="text-[24px] font-black uppercase leading-none" style={{ color: tc(data.tone) }}>
              {data.bias === "BULLISH" ? "BULL" : data.bias === "BEARISH" ? "BEAR" : "NEUTRAL"}
            </div>
          </div>
          <div className="text-right text-[10px] uppercase">
            <div className={data.bias === "BULLISH" ? "text-emerald-300" : "text-white/45"}>
              ✓ BUYERS IN CONTROL
            </div>
            <div className={data.premiumAccept.state === "OPTION ACCEPTANCE" ? "text-emerald-300" : "text-white/45"}>
              ✓ PREMIUM ACCEPTANCE CONFIRMED
            </div>
            <div className={data.footprint.signal?.includes("INSTITUTIONAL") ? "text-emerald-300" : "text-white/45"}>
              ✓ INSTITUTIONAL SUPPORT ACTIVE
            </div>
            <div className={data.score >= 70 ? "text-emerald-300" : "text-white/45"}>
              ✓ HIGH PROBABILITY {data.bias === "BULLISH" ? "LONG" : data.bias === "BEARISH" ? "SHORT" : "—"} SETUP
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ═══════════════ GOLDEN CONNECTION ═══════════════════════════════════ */
function GoldenConnectionCard({ data }: { data: OrderFlowResponse }) {
  return (
    <Card num="" title="GOLDEN CONNECTION WITH YOUR DASHBOARD">
      <div className="grid grid-cols-4 items-center gap-1 text-center text-[10px] uppercase">
        <Pill big="V2" small="WHO HOLDS POSITION" tone="bull" />
        <span className="text-[18px] font-black text-white/65">+</span>
        <Pill big="V6" small="WHO CONTROLS STRUCTURE" tone="strongbull" />
        <span className="text-[18px] font-black text-white/65">+</span>
        <Pill big="ORDER FLOW" small="WHO IS ATTACKING NOW" tone="bear" />
        <span className="text-[18px] font-black text-white/65">=</span>
        <Pill big="COMPLETE" small="INSTITUTIONAL PICTURE" tone="neutral" />
      </div>
      <div className="mt-auto grid grid-cols-4 items-center gap-1 rounded border border-white/10 bg-white/[0.02] px-2 py-1.5 text-center text-[10px] uppercase">
        <span className="text-emerald-300">⊙ POSITIONING</span>
        <span className="text-white/45">+</span>
        <span className="text-amber-300">⊙ ACCEPTANCE</span>
        <span className="text-rose-300">+ ⊙ ORDER FLOW</span>
      </div>
      <div className="text-center text-[11px] uppercase tracking-wide text-cyan-300">
        ⊙ CONFIDENCE · {data.weightedScore}/100
      </div>
    </Card>
  );
}
function Pill({ big, small, tone }: { big: string; small: string; tone: string }) {
  const color = tc(tone);
  return (
    <div className="flex flex-col rounded border px-1.5 py-1.5"
      style={{ borderColor: `${color}66`, background: `${color}10` }}>
      <span className="text-[12px] font-black uppercase" style={{ color }}>{big}</span>
      <span className="text-[9px] uppercase tracking-wide text-white/55">{small}</span>
    </div>
  );
}


/* ═══════════════ REVERSAL PROBABILITY CARD ════════════════════════════ */
function ReversalCard({ data }: { data: OrderFlowResponse }) {
  const r = data.reversal;
  const color = tc(r.tone);
  return (
    <div className="grid grid-cols-12 items-stretch gap-2 rounded border bg-[#0a0f17] px-3 py-2"
      style={{ borderColor: `${color}55`, background: `${color}10` }}>
      <div className="col-span-3 flex flex-col justify-center">
        <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-white/55">REVERSAL ENGINE</span>
        <span className="text-[18px] font-black uppercase tracking-wide" style={{ color }}>
          {r.label}
        </span>
        <span className="text-[11px] uppercase text-white/55">{r.desc}</span>
      </div>

      <div className="col-span-4 flex items-center gap-3">
        <div className="flex flex-col items-center">
          <span className="text-[10px] font-bold uppercase text-emerald-300">BULLISH REVERSAL ↑</span>
          <span className="font-mono text-[26px] font-black text-emerald-400">{r.bullishProb}%</span>
        </div>
        <div className="flex h-3 flex-1 overflow-hidden rounded-full bg-white/10">
          <div className="bg-emerald-500" style={{ width: `${r.bullishProb}%` }} />
        </div>
      </div>

      <div className="col-span-4 flex items-center gap-3">
        <div className="flex flex-col items-center">
          <span className="text-[10px] font-bold uppercase text-rose-300">BEARISH REVERSAL ↓</span>
          <span className="font-mono text-[26px] font-black text-rose-400">{r.bearishProb}%</span>
        </div>
        <div className="flex h-3 flex-1 overflow-hidden rounded-full bg-white/10">
          <div className="bg-rose-500" style={{ width: `${r.bearishProb}%` }} />
        </div>
      </div>

      <div className="col-span-1 flex flex-col items-center justify-center rounded border border-white/15 bg-black/40 px-2 py-1">
        <span className="text-[10px] uppercase text-white/55">BIAS</span>
        <span className="text-[14px] font-black uppercase" style={{ color }}>{r.bias}</span>
      </div>
    </div>
  );
}

/* ═══════════════ PER-STRIKE DECISION GRID (ATM ± 6) ══════════════════ */
function PerStrikeGrid({ data }: { data: OrderFlowResponse }) {
  return (
    <div className="rounded border border-white/15 bg-[#0a0f17] p-2">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-black uppercase tracking-[0.10em] text-amber-300">
            ORDER FLOW DECISION ENGINE · ATM ± 6 ROUND-100 STRIKES
          </span>
          <span className="text-[11px] uppercase tracking-wide text-white/45">
            CE BUY / PE BUY / WAIT per strike + reversal probability
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px] uppercase text-white/55">
          <span><span className="inline-block h-2 w-2 rounded-sm bg-emerald-500" /> BUY CE</span>
          <span><span className="inline-block h-2 w-2 rounded-sm bg-rose-500" /> BUY PE</span>
          <span><span className="inline-block h-2 w-2 rounded-sm bg-yellow-400" /> WAIT</span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="text-[10px] font-bold uppercase tracking-wide text-white/55">
              <th className="border-b border-white/10 px-1 py-1 text-left">STRIKE</th>
              <th className="border-b border-white/10 px-1 py-1">OFFSET</th>
              <th className="border-b border-white/10 px-1 py-1">CE LTP</th>
              <th className="border-b border-white/10 px-1 py-1">CE Δ%</th>
              <th className="border-b border-white/10 px-1 py-1">CE OIΔ</th>
              <th className="border-b border-white/10 px-1 py-1">CE SCORE</th>
              <th className="border-b border-white/10 px-1 py-1">PE LTP</th>
              <th className="border-b border-white/10 px-1 py-1">PE Δ%</th>
              <th className="border-b border-white/10 px-1 py-1">PE OIΔ</th>
              <th className="border-b border-white/10 px-1 py-1">PE SCORE</th>
              <th className="border-b border-white/10 px-1 py-1">REVERSAL</th>
              <th className="border-b border-white/10 px-1 py-1">ACTION</th>
              <th className="border-b border-white/10 px-1 py-1 text-left">REASONING</th>
            </tr>
          </thead>
          <tbody>
            {data.strikes.map((s) => {
              const action = s.action;
              const aTone = tc(s.actionTone);
              const ceTone = s.ce.score >= 60 ? "#22c55e" : s.ce.score >= 40 ? "#eab308" : "#94a3b8";
              const peTone = s.pe.score >= 60 ? "#22c55e" : s.pe.score >= 40 ? "#eab308" : "#94a3b8";
              const revTone = s.reversalProb >= 60 ? "#22c55e" : s.reversalProb >= 40 ? "#eab308" : "#94a3b8";
              return (
                <tr key={s.strike} className="border-b border-white/5"
                  style={{ background: s.isAtm ? "rgba(245,158,11,0.10)" : "transparent" }}>
                  <td className="px-1 py-1 text-left">
                    <span className="font-mono font-black"
                      style={{ color: s.isAtm ? "#f59e0b" : "rgba(255,255,255,0.85)" }}>
                      {s.strike}{s.isAtm ? "*" : ""}
                    </span>
                  </td>
                  <td className="px-1 py-1 text-center font-mono text-white/65">
                    {s.offset >= 0 ? `+${s.offset}` : s.offset}
                  </td>
                  <td className="px-1 py-1 text-center font-mono text-white/85">{s.ce.ltp}</td>
                  <td className="px-1 py-1 text-center font-mono"
                    style={{ color: s.ce.premPct >= 0 ? "#22c55e" : "#ef4444" }}>
                    {s.ce.premPct >= 0 ? "+" : ""}{s.ce.premPct}%
                  </td>
                  <td className="px-1 py-1 text-center font-mono"
                    style={{ color: s.ce.oiChange >= 0 ? "#94a3b8" : "#22c55e" }}>
                    {fmtSigned(s.ce.oiChange)}
                  </td>
                  <td className="px-1 py-1 text-center font-mono font-black" style={{ color: ceTone }}>
                    {s.ce.score}
                  </td>
                  <td className="px-1 py-1 text-center font-mono text-white/85">{s.pe.ltp}</td>
                  <td className="px-1 py-1 text-center font-mono"
                    style={{ color: s.pe.premPct >= 0 ? "#22c55e" : "#ef4444" }}>
                    {s.pe.premPct >= 0 ? "+" : ""}{s.pe.premPct}%
                  </td>
                  <td className="px-1 py-1 text-center font-mono"
                    style={{ color: s.pe.oiChange >= 0 ? "#94a3b8" : "#22c55e" }}>
                    {fmtSigned(s.pe.oiChange)}
                  </td>
                  <td className="px-1 py-1 text-center font-mono font-black" style={{ color: peTone }}>
                    {s.pe.score}
                  </td>
                  <td className="px-1 py-1 text-center font-mono font-black" style={{ color: revTone }}>
                    {s.reversalProb}%
                  </td>
                  <td className="px-1 py-1 text-center">
                    <span className="rounded px-2 py-0.5 text-[11px] font-black uppercase tracking-wide"
                      style={{ background: `${aTone}1f`, border: `1px solid ${aTone}77`, color: aTone }}>
                      {action}
                    </span>
                  </td>
                  <td className="px-1 py-1 text-left text-[10px] uppercase tracking-wide text-white/55">
                    {s.reasoning}
                  </td>
                </tr>
              );
            })}
            {data.strikes.length === 0 ? (
              <tr><td colSpan={13} className="py-3 text-center text-white/45">No strikes available</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex items-center justify-between rounded border border-white/10 bg-white/[0.02] px-3 py-1.5 text-[11px]">
        <span className="uppercase text-white/55">AGGREGATE DECISION</span>
        <span className="uppercase text-white/55">CE WINNERS {data.decision.ceWinners} / PE WINNERS {data.decision.peWinners}</span>
        <span className="text-[14px] font-black uppercase tracking-wide" style={{ color: tc(data.decision.tone) }}>
          {data.decision.action}
        </span>
        <span className="uppercase text-white/55">{data.decision.summary}</span>
      </div>
    </div>
  );
}

/* ═══════════════ FOOTER STRIP ════════════════════════════════════════ */
function FooterStrip({ data }: { data: OrderFlowResponse }) {
  void data;
  return (
    <div className="grid grid-cols-12 gap-2">
      <div className="col-span-4 rounded border border-white/15 bg-[#0a0f17] p-2">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[11px] font-black uppercase tracking-[0.16em] text-amber-300">⊙ HOW TO USE (SIDE-VIEW LOGIC)</span>
        </div>
        <ol className="list-decimal pl-4 text-[10px] leading-tight text-white/65">
          <li>Use V2 &amp; V6 to identify where institutions are positioned.</li>
          <li>Use Order Flow Engine to see who is attacking NOW.</li>
          <li>Look for Alignment + Acceptance + Absorption.</li>
          <li>Take Order Flow trades in the direction of the winner.</li>
        </ol>
      </div>
      <div className="col-span-4 rounded border border-white/15 bg-[#0a0f17] p-2">
        <div className="mb-1 text-[11px] font-black uppercase tracking-[0.16em] text-emerald-300">EXAMPLE LOGIC</div>
        <div className="text-[10px] uppercase text-white/55">SPOT AT VAH + BUYERS ATTACKING</div>
        <div className="mt-1 grid grid-cols-5 items-center gap-1 text-center text-[10px] uppercase">
          <Tag txt="DELTA POSITIVE" tone="bull" />
          <Tag txt="ABSORPTION SELLER" tone="bear" />
          <Tag txt="PREMIUM CE RISING" tone="bull" />
          <Tag txt="ALIGN BULL" tone="bull" />
          <span className="text-[14px] font-black text-emerald-400">→ CE BUY</span>
        </div>
      </div>
      <div className="col-span-4 rounded border border-white/15 bg-[#0a0f17] p-2">
        <div className="mb-1 text-[11px] font-black uppercase tracking-[0.16em] text-rose-300">EXAMPLE LOGIC</div>
        <div className="text-[10px] uppercase text-white/55">SPOT AT VAL + SELLERS ATTACKING</div>
        <div className="mt-1 grid grid-cols-5 items-center gap-1 text-center text-[10px] uppercase">
          <Tag txt="DELTA NEGATIVE" tone="bear" />
          <Tag txt="ABSORPTION BUYER" tone="bull" />
          <Tag txt="PREMIUM PE RISING" tone="bear" />
          <Tag txt="ALIGN BEAR" tone="bear" />
          <span className="text-[14px] font-black text-rose-400">→ PE BUY</span>
        </div>
      </div>
    </div>
  );
}
function Tag({ txt, tone }: { txt: string; tone: string }) {
  const color = tc(tone);
  return (
    <span className="rounded px-1 py-0.5 text-[9px] font-black uppercase"
      style={{ background: `${color}1a`, color, border: `1px solid ${color}55` }}>
      {txt}
    </span>
  );
}

/* unused imports kept for type-completeness */
type _Unused = OFCard; void (null as unknown as _Unused);
