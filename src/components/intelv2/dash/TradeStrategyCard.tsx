import type { IntelV2Snapshot } from "@/lib/intelV2Types";
import { V2Card, V2_TONE } from "./common";

/**
 * 🎯 TRADE STRATEGY ENGINE — pure-logic state-driven hierarchy.
 * ========================================================================
 * Replaces the legacy "score-accumulation" verdict with an institutional
 * 5-layer state machine:
 *
 *   MARKET STATE   → can this strategy even exist?
 *   FLOW STATE     → who is pressing right now?
 *   STRUCTURE      → where is price relative to value?
 *   ENTRY QUALITY  → is timing good NOW?
 *   STRATEGY       → final action (BUY CE / BUY PE / WAIT)
 *   INVALIDATION   → what proves this trade WRONG?
 *
 * Backend lives at `data.dashboard.tradeStrategy` and exposes the new
 * fields: marketState, flowState, structureState, entryQuality,
 * invalidations[], riskLevel, gatedKey.
 *
 * The card is built with overflow-y-auto so long invalidation lists
 * never bleed past the card boundary.
 */
export function TradeStrategyCard({ data }: { data: IntelV2Snapshot | null }) {
  const ts = data?.dashboard?.tradeStrategy;
  if (!ts) {
    return (
      <V2Card title="🎯 Trade Strategy Engine">
        <div className="flex h-full items-center justify-center text-[12px] text-white/40">
          Synthesising signals…
        </div>
      </V2Card>
    );
  }

  const t = V2_TONE[ts.tone];
  const isWait = ts.verdict === "WAIT" || ts.gatedKey === "NO_TRADE";

  // Tone helpers for the state pills
  const stateTone: Record<string, "bull" | "bear" | "warn" | "info" | "neutral"> = {
    TREND_DISCOVERY: "info",
    RANGE_ROTATION: "warn",
    GAMMA_PINNED: "neutral",
    PANIC_EXPANSION: "bear",
    OPENING_AUCTION: "warn",
  };
  const flowTone: Record<string, "bull" | "bear" | "warn" | "neutral"> = {
    BUYERS_DOMINANT: "bull",
    SELLERS_DOMINANT: "bear",
    ABSORPTION: "warn",
    EXHAUSTION: "warn",
    BALANCED: "neutral",
  };
  const structureTone: Record<string, "bull" | "bear" | "warn"> = {
    STRONG_BULLISH: "bull",
    STRONG_BEARISH: "bear",
    NEUTRAL: "warn",
  };
  const entryTone: Record<string, "bull" | "bear" | "warn" | "neutral"> = {
    GOOD: "bull",
    PULLBACK: "bull",
    LATE: "bear",
    NO_EDGE: "neutral",
  };

  const ms = ts.marketState ?? "RANGE_ROTATION";
  const fs = ts.flowState ?? "BALANCED";
  const ss = ts.structureState ?? "NEUTRAL";
  const eq = ts.entryQuality ?? "NO_EDGE";
  const risk = ts.riskLevel ?? "MEDIUM";

  return (
    <V2Card
      title={
        <span className="flex items-center gap-2">
          <span>🎯</span>
          Trade Strategy Engine
        </span>
      }
      accent={ts.tone}
    >
      <div className="-m-1.5 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-1.5 pr-2">
        {/* ─── LAYER 5 — STRATEGY (headline) ─────────────────────────── */}
        <div
          className="flex items-center gap-2 rounded-md border px-2.5 py-1.5"
          style={{ background: t.soft, borderColor: t.border }}
        >
          <span className="text-[18px] leading-none">{ts.icon}</span>
          <div className="flex flex-col">
            <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-white/55">
              Strategy
            </span>
            <span
              className="text-[14px] font-black uppercase leading-none tracking-wider"
              style={{ color: t.color }}
            >
              {ts.strategy}
            </span>
          </div>
          <div className="ml-auto flex flex-col items-end">
            <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-white/55">
              Verdict
            </span>
            <span
              className="text-[14px] font-black uppercase leading-none tracking-wider"
              style={{ color: t.color }}
            >
              {isWait ? "NO TRADE" : ts.verdict}
            </span>
          </div>
        </div>

        {/* TRADE BLOCK — strike + risk pill */}
        {!isWait && ts.strike != null ? (
          <div
            className="grid grid-cols-[1fr_auto] items-center gap-2 rounded-md border px-2.5 py-1.5"
            style={{ background: t.soft, borderColor: t.border }}
          >
            <div className="flex flex-col">
              <span className="text-[8px] font-bold uppercase tracking-[0.18em] text-white/55">Trade</span>
              <span className="font-mono text-[18px] font-black leading-none" style={{ color: t.color }}>
                {ts.strike.toLocaleString()} {ts.side}
              </span>
              <span className="text-[10px] font-semibold leading-tight" style={{ color: t.color, opacity: 0.85 }}>
                {ts.headline}
              </span>
              <span className="text-[9px] text-white/55">{ts.subline}</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <span
                className="rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-wider"
                style={{
                  background: risk === "LOW" ? "rgba(34,197,94,0.18)"
                    : risk === "HIGH" ? "rgba(239,68,68,0.18)"
                    : "rgba(250,204,21,0.18)",
                  color: risk === "LOW" ? "#22c55e"
                    : risk === "HIGH" ? "#ef4444"
                    : "#facc15",
                }}
              >
                Risk: {risk}
              </span>
            </div>
          </div>
        ) : (
          <div
            className="rounded-md border px-2.5 py-2 text-center"
            style={{ background: t.soft, borderColor: t.border }}
          >
            <div className="text-[14px] font-black uppercase tracking-wider" style={{ color: t.color }}>
              No Trade
            </div>
            <div className="text-[10px] text-white/65">{ts.subline}</div>
          </div>
        )}

        {/* ─── LAYERS 1-4 — STATE MACHINE (4-cell grid) ──────────────── */}
        <div className="grid grid-cols-2 gap-1.5">
          <StateCell
            label="Market State"
            value={ms.replace(/_/g, " ")}
            tone={stateTone[ms] || "neutral"}
          />
          <StateCell
            label="Flow"
            value={fs.replace(/_/g, " ")}
            tone={flowTone[fs] || "neutral"}
          />
          <StateCell
            label="Structure"
            value={ss.replace(/_/g, " ")}
            tone={structureTone[ss] || "warn"}
          />
          <StateCell
            label="Entry Quality"
            value={eq.replace(/_/g, " ")}
            tone={entryTone[eq] || "neutral"}
          />
        </div>

        {/* ─── REASON (firing signals) ──────────────────────────────── */}
        {ts.topReasons.length > 0 ? (
          <div className="flex flex-col gap-0.5 rounded-md border border-white/[0.08] bg-white/[0.02] px-2 py-1.5">
            <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-white/55">
              ✓ Reason
            </span>
            <ul className="flex flex-col gap-0.5 text-[10px] leading-tight text-white/80">
              {ts.topReasons.map((r, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <span className="mt-0.5 shrink-0" style={{ color: t.color }}>▸</span>
                  <span className="break-words">{r}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* ─── INVALIDATION (what proves this trade WRONG) ──────────── */}
        {ts.invalidations && ts.invalidations.length > 0 ? (
          <div className="flex flex-col gap-0.5 rounded-md border border-amber-500/40 bg-amber-500/[0.06] px-2 py-1.5">
            <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-amber-300">
              ⚠ Invalidation
            </span>
            <ul className="flex flex-col gap-0.5 text-[10px] leading-tight text-white/80">
              {ts.invalidations.map((r, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <span className="mt-0.5 shrink-0 text-amber-300">×</span>
                  <span className="break-words">{r}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </V2Card>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * StateCell — one cell of the 4-cell state-machine grid.
 * Shows the layer label (Market State / Flow / Structure / Entry Quality)
 * and a coloured value pill.
 * ───────────────────────────────────────────────────────────────────── */
function StateCell({
  label, value, tone,
}: {
  label: string;
  value: string;
  tone: "bull" | "bear" | "warn" | "info" | "neutral";
}) {
  const t = V2_TONE[tone];
  return (
    <div
      className="flex flex-col gap-0.5 rounded-md border px-2 py-1"
      style={{ borderColor: t.border, background: t.soft }}
    >
      <span className="text-[8px] font-bold uppercase tracking-[0.18em] text-white/55">
        {label}
      </span>
      <span
        className="text-[11px] font-black uppercase leading-tight tracking-wider"
        style={{ color: t.color }}
      >
        {value}
      </span>
    </div>
  );
}
