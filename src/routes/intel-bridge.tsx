import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { isAuthenticated } from "@/lib/auth";
import { useIntelBridgeDecision } from "@/hooks/useIntelBridgeDecision";
import type { BridgeSymbol, BridgeDecision } from "@/lib/intelBridgeTypes";

export const Route = createFileRoute("/intel-bridge")({
  component: IntelBridgePage,
});

/**
 * INTEL BRIDGE — INSTITUTIONAL INTENT CONVERTER (V2 → V6)
 * ========================================================================
 * The brain that connects the two engines:
 *   Positioning (V2) → Conviction → Premium Expansion → Trade Decision (V6)
 */
function IntelBridgePage() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!isAuthenticated()) navigate({ to: "/login" });
  }, [navigate]);

  const [symbol, setSymbol] = useState<BridgeSymbol>("NIFTY_50");
  const [date, setDate] = useState<string | null>(null);
  const { data, loading, lastFetchAt, refetch } = useIntelBridgeDecision({ symbol, date, intervalMs: 3000 });

  return (
    <div className="intelbridge-root fixed inset-0 left-3 flex flex-col bg-[#060a10] font-sans text-white">
      <header className="flex items-center justify-between border-b border-white/10 bg-[#0a0e15] px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="text-[15px] font-bold tracking-[0.18em] text-violet-300">
            INTEL <span className="rounded-sm bg-violet-400/15 px-1.5 py-0.5 text-[13px]">BRIDGE</span>
          </span>
          <span className="text-[12px] uppercase tracking-[0.16em] text-white/50">Institutional Intent Converter · V2 → V6</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md bg-white/[0.05] p-0.5">
            {(["NIFTY_50", "SENSEX"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSymbol(s)}
                className={`rounded px-3 py-1 text-[13px] font-bold tracking-wider transition-colors ${
                  symbol === s ? "bg-violet-500/20 text-violet-300" : "text-white/55 hover:text-white"
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

      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
        {!data ? (
          <div className="flex h-full items-center justify-center text-[16px] text-white/45">Loading Bridge…</div>
        ) : !data.ok ? (
          <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-6 text-rose-300">
            <div className="text-[15px] font-bold uppercase tracking-wider">Bridge Error</div>
            <div className="mt-2 text-[14px]">{(data as unknown as { error?: string }).error || "Unable to load."}</div>
          </div>
        ) : (
          <BridgeDashboard data={data} />
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
  return TONE[t] || (t === "BULL" || t === "BULLISH" ? "#22c55e" : t === "BEAR" || t === "BEARISH" ? "#ef4444" : "#eab308");
}
function todayIST(): string {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
}

/* ═══════════════════════════════════════════════════════════════════════
 * BRIDGE DASHBOARD
 * ═══════════════════════════════════════════════════════════════════════ */
function BridgeDashboard({ data }: { data: BridgeDecision }) {
  return (
    <div className="flex w-full flex-col gap-3">
      {/* Flow diagram: Readiness → Positioning → Conviction → Premium → Decision */}
      <FlowDiagram data={data} />

      {/* Market Readiness gatekeeper */}
      <MarketReadiness data={data} />

      {/* Conviction meter + Premium expansion */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ConvictionMeter data={data} />
        <PremiumExpansion data={data} />
      </div>

      {/* Drivers + Bridge verdict */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_360px]">
        <DriversCard data={data} />
        <VerdictCard data={data} />
      </div>

      {/* Source engines reference */}
      <SourcesCard data={data} />

      <div className="pb-1 text-center text-[11px] uppercase tracking-[0.18em] text-white/35">
        {data.goldenRule}
      </div>
    </div>
  );
}

/* ═══════════════ MARKET READINESS (gatekeeper) ════════════════════════ */
function MarketReadiness({ data }: { data: BridgeDecision }) {
  const mr = data.marketReadiness;
  const color = tc(mr.tone);
  return (
    <div className="rounded-xl border-2 bg-[#0a0e15] p-4" style={{ borderColor: `${color}55` }}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] font-bold uppercase tracking-[0.16em] text-amber-300">Market Readiness Engine</span>
        <span className="rounded px-2 py-0.5 text-[11px] font-black uppercase tracking-wide"
          style={{ background: mr.ok ? "#22c55e1a" : "#ef44441a", border: `1px solid ${mr.ok ? "#22c55e66" : "#ef444466"}`, color: mr.ok ? "#22c55e" : "#ef4444" }}>
          {mr.ok ? "GATE OPEN" : "GATE BLOCKED"}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[160px_1fr]">
        {/* score */}
        <div className="flex flex-col items-center justify-center rounded-lg border px-3 py-3"
          style={{ borderColor: `${color}55`, background: `${color}10` }}>
          <span className="font-mono text-[46px] font-black leading-none" style={{ color }}>{mr.score}</span>
          <span className="text-[10px] font-bold uppercase tracking-wide text-white/45">/ 100</span>
          <span className="mt-1 text-[15px] font-black uppercase tracking-wide" style={{ color }}>{mr.status}</span>
        </div>

        {/* sections */}
        <div className="flex flex-col justify-center gap-2">
          {mr.sections.map((s) => (
            <ReadinessBar key={s.key} section={s} />
          ))}
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-[12px] leading-snug text-white/75">
        {mr.interpretation}
      </div>
    </div>
  );
}

function ReadinessBar({ section }: { section: BridgeDecision["marketReadiness"]["sections"][number] }) {
  const pct = section.max > 0 ? (section.score / section.max) * 100 : 0;
  const color = pct >= 80 ? "#16c784" : pct >= 50 ? "#22c55e" : pct >= 30 ? "#eab308" : "#ef4444";
  const blocks = Math.round((section.score / section.max) * 8);
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-bold uppercase tracking-wide text-white/60">{section.key}</span>
        <span className="font-mono font-black" style={{ color }}>{section.score}/{section.max}</span>
      </div>
      <div className="mt-0.5 flex items-center gap-2">
        <span className="flex gap-[2px]">
          {Array.from({ length: 8 }).map((_, i) => (
            <span key={i} className="h-2.5 w-3 rounded-[1px]"
              style={{ background: i < blocks ? color : "rgba(255,255,255,0.10)" }} />
          ))}
        </span>
        <span className="text-[9px] text-white/45">
          {section.items.filter((x) => x.ok).map((x) => x.label.replace(/\s*\(.*\)/, "")).join(" · ") || "—"}
        </span>
      </div>
    </div>
  );
}

/* ═══════════════ FLOW DIAGRAM ═════════════════════════════════════════ */
function FlowDiagram({ data }: { data: BridgeDecision }) {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-[#0a0e15] p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] font-bold uppercase tracking-[0.16em] text-violet-300">Institutional Intent Flow</span>
        <span className="font-mono text-[13px] text-white/65">
          {data.symbol === "SENSEX" ? "SENSEX" : "NIFTY"} <span className="font-black text-white/90">{data.header.spot.toLocaleString()}</span>
          <span className="ml-1" style={{ color: data.header.change >= 0 ? "#22c55e" : "#ef4444" }}>
            {data.header.change >= 0 ? "+" : ""}{data.header.changePct}%
          </span>
        </span>
      </div>
      <div className="flex items-stretch gap-1">
        {data.flowStages.map((s, i) => {
          const color = tc(s.tone);
          return (
            <div key={i} className="flex flex-1 items-stretch">
              <div className="flex flex-1 flex-col rounded-lg border-2 px-3 py-2.5"
                style={{ borderColor: `${color}66`, background: `${color}12` }}>
                <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/50">{s.stage}</span>
                <span className="text-[9px] uppercase tracking-wide text-white/35">{s.source}</span>
                <span className="mt-1 text-[14px] font-black uppercase leading-tight" style={{ color }}>{s.value}</span>
              </div>
              {i < data.flowStages.length - 1 ? (
                <div className="flex items-center px-1 text-[20px] text-white/30">→</div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ═══════════════ CONVICTION METER ═════════════════════════════════════ */
function ConvictionMeter({ data }: { data: BridgeDecision }) {
  const c = data.conviction;
  const color = tc(c.tone);
  return (
    <div className="rounded-xl border border-white/[0.08] bg-[#0a0e15] p-4">
      <div className="mb-2 text-[12px] font-bold uppercase tracking-[0.16em] text-white/85">Institutional Conviction Meter</div>

      <div className="flex items-center gap-4">
        <div className="flex flex-col items-center">
          <span className="font-mono text-[44px] font-black leading-none" style={{ color }}>{c.value}</span>
          <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color }}>{c.side} · {c.tier}</span>
        </div>
        <div className="flex flex-1 flex-col gap-2">
          <ConvictionBar label="Bull Conviction" value={c.bull} color="#22c55e" />
          <ConvictionBar label="Bear Conviction" value={c.bear} color="#ef4444" />
        </div>
      </div>

      {/* tier scale */}
      <div className="mt-3 flex gap-1">
        {[
          { r: "0-20", l: "NONE" },
          { r: "20-40", l: "WEAK" },
          { r: "40-60", l: "BUILDING" },
          { r: "60-80", l: "STRONG" },
          { r: "80-100", l: "AGGRESSIVE" },
        ].map((t, i) => {
          const active = c.tier === t.l || (c.tier === "NO CONVICTION" && t.l === "NONE");
          return (
            <div key={i} className="flex flex-1 flex-col items-center rounded px-1 py-1"
              style={{ background: active ? `${color}22` : "rgba(255,255,255,0.03)", border: `1px solid ${active ? `${color}77` : "rgba(255,255,255,0.06)"}` }}>
              <span className="text-[9px] font-bold uppercase" style={{ color: active ? color : "rgba(255,255,255,0.4)" }}>{t.l}</span>
              <span className="text-[8px] text-white/35">{t.r}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ConvictionBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div className="flex items-center justify-between text-[10px]">
        <span className="font-bold uppercase tracking-wide text-white/55">{label}</span>
        <span className="font-mono font-black" style={{ color }}>{value}%</span>
      </div>
      <div className="mt-0.5 h-2.5 w-full overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full" style={{ width: `${value}%`, background: color, transition: "width .5s ease" }} />
      </div>
    </div>
  );
}

/* ═══════════════ PREMIUM EXPANSION ════════════════════════════════════ */
function PremiumExpansion({ data }: { data: BridgeDecision }) {
  const p = data.premium;
  const color = tc(p.tone);
  return (
    <div className="rounded-xl border border-white/[0.08] bg-[#0a0e15] p-4">
      <div className="mb-2 text-[12px] font-bold uppercase tracking-[0.16em] text-white/85">Premium Expansion Probability</div>

      <div className="flex items-center gap-4">
        <div className="flex flex-col items-center">
          <span className="font-mono text-[44px] font-black leading-none" style={{ color }}>{p.probability}</span>
          <span className="text-[10px] font-bold uppercase tracking-wide text-white/45">/ 100</span>
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <span className="text-[16px] font-black uppercase leading-tight" style={{ color }}>{p.expectedBehavior}</span>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <ConfirmChip label="Greeks" ok={p.greeksAgree} />
            <ConfirmChip label="Strike Mom" ok={p.strikeAgree} />
            <ConfirmChip label="Gamma Exp" ok={p.gammaExpansion} />
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <MiniStat label="V6 PEX Score" value={`${p.pexScore}`} sub={p.pexState} tone={p.pexState === "EXPANDING" ? "#22c55e" : p.pexState === "DECAYING" ? "#ef4444" : "#eab308"} />
        <MiniStat label="Dealer Gamma" value={p.gammaRegime.replace(" GAMMA", "")} sub={p.gammaPremium} tone={p.gammaPremium === "EXPANSION" ? "#22c55e" : p.gammaPremium === "DECAY" ? "#ef4444" : "#eab308"} />
        <MiniStat label="Behavior" value={p.probability >= 60 ? "EXPANDING" : p.probability >= 40 ? "CHOPPY" : "DECAY"} tone={color} />
      </div>
    </div>
  );
}

function ConfirmChip({ label, ok }: { label: string; ok: boolean }) {
  const color = ok ? "#22c55e" : "#64748b";
  return (
    <span className="rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
      style={{ background: `${color}1a`, border: `1px solid ${color}55`, color }}>
      {ok ? "✓" : "○"} {label}
    </span>
  );
}

function MiniStat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: string }) {
  return (
    <div className="rounded border border-white/10 bg-white/[0.02] px-1.5 py-1.5">
      <div className="text-[9px] font-bold uppercase tracking-wide text-white/45">{label}</div>
      <div className="text-[13px] font-black uppercase leading-tight" style={{ color: tone }}>{value}</div>
      {sub ? <div className="text-[8px] uppercase text-white/45">{sub}</div> : null}
    </div>
  );
}

/* ═══════════════ DRIVERS ══════════════════════════════════════════════ */
function DriversCard({ data }: { data: BridgeDecision }) {
  const drivers = data.drivers;
  return (
    <div className="rounded-xl border border-white/[0.08] bg-[#0a0e15] p-4">
      <div className="mb-2 text-[12px] font-bold uppercase tracking-[0.16em] text-white/85">
        Conviction Drivers <span className="text-white/45">({drivers.length})</span>
      </div>
      {drivers.length === 0 ? (
        <div className="py-4 text-center text-[12px] text-white/40">No committed institutional drivers yet.</div>
      ) : (
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {drivers.map((dr, i) => {
            const color = dr.side === "BULL" ? "#22c55e" : "#ef4444";
            return (
              <div key={i} className="flex items-center gap-2 rounded border px-2.5 py-1.5"
                style={{ borderColor: `${color}40`, background: `${color}10` }}>
                <span className="text-[14px]" style={{ color }}>✓</span>
                <span className="text-[12px] text-white/85">{dr.label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ═══════════════ VERDICT ══════════════════════════════════════════════ */
function VerdictCard({ data }: { data: BridgeDecision }) {
  const v = data.verdict;
  const color = tc(v.tone);
  const gateTone = v.v6Gate === "CONFIRMED" ? "#22c55e" : v.v6Gate === "N/A" ? "#64748b" : "#eab308";
  return (
    <div className="flex flex-col rounded-xl border-2 bg-[#0a0e15] p-4" style={{ borderColor: `${color}55` }}>
      <div className="text-center text-[12px] font-bold uppercase tracking-[0.16em] text-white/70">Bridge Verdict</div>
      <div className="my-2 text-center font-black uppercase leading-none tracking-wide"
        style={{ color, fontSize: v.label.length > 10 ? 30 : 40, textShadow: `0 0 16px ${color}44` }}>
        {v.label}
      </div>
      <div className="flex items-center justify-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-white/55">V6 Gate</span>
        <span className="rounded px-2 py-0.5 text-[11px] font-black uppercase" style={{ background: `${gateTone}1f`, border: `1px solid ${gateTone}66`, color: gateTone }}>
          {v.v6Gate}
        </span>
      </div>
      <div className="mt-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-center text-[12px] leading-snug text-white/75">
        {v.rationale}
      </div>
    </div>
  );
}

/* ═══════════════ SOURCES ══════════════════════════════════════════════ */
function SourcesCard({ data }: { data: BridgeDecision }) {
  const v2 = data.sources.v2;
  const v6 = data.sources.v6;
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <div className="rounded-xl border border-white/[0.08] bg-[#0a0e15] p-3">
        <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-sky-300">Layer 1 · V2 Positioning</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
          <SrcRow k="OI Shift" v={`${v2.oiShiftSide} · ${v2.oiShiftBullPct}%`} />
          <SrcRow k="Market View" v={v2.marketView || "—"} />
          <SrcRow k="Delta Flow" v={`${v2.deltaPct >= 0 ? "+" : ""}${v2.deltaPct}%`} tone={v2.deltaPct > 8 ? "#22c55e" : v2.deltaPct < -8 ? "#ef4444" : "#eab308"} />
          <SrcRow k="Breadth" v={`${v2.breadthPct}%`} tone={v2.breadthPct >= 58 ? "#22c55e" : v2.breadthPct <= 42 ? "#ef4444" : "#eab308"} />
          <SrcRow k="PCR" v={`${v2.pcr}`} />
          <SrcRow k="Fut Premium" v={`${v2.futPremium >= 0 ? "+" : ""}${v2.futPremium}`} tone={v2.futPremium > 5 ? "#22c55e" : v2.futPremium < -5 ? "#ef4444" : "#eab308"} />
        </div>
      </div>
      <div className="rounded-xl border border-white/[0.08] bg-[#0a0e15] p-3">
        <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-cyan-300">Layer 3 · V6 Decision</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
          <SrcRow k="Setup" v={v6.setup} />
          <SrcRow k="Net Score" v={`${v6.netScore}`} tone={v6.netScore >= 20 ? "#22c55e" : v6.netScore <= -20 ? "#ef4444" : "#eab308"} />
          <SrcRow k="Alignment" v={`${v6.alignment || "—"} (${v6.grade || "—"})`} />
          <SrcRow k="Greeks Side" v={v6.greeksSide} />
          <SrcRow k="Strike Mom" v={v6.strikeMomentum} />
          <SrcRow k="Buyer Quality" v={`${v6.buyerQuality}/100`} tone={v6.buyerQuality >= 60 ? "#22c55e" : v6.buyerQuality >= 40 ? "#eab308" : "#ef4444"} />
          <SrcRow k="Auction" v={v6.auctionZone} />
        </div>
      </div>
    </div>
  );
}

function SrcRow({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-white/[0.05] py-0.5">
      <span className="uppercase tracking-wide text-white/50">{k}</span>
      <span className="font-mono font-bold uppercase" style={{ color: tone || "rgba(255,255,255,0.85)" }}>{v}</span>
    </div>
  );
}
