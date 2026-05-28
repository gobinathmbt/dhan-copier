import type { IntelV2Snapshot } from "@/lib/intelV2Types";
import { V2Card, V2_TONE } from "./common";

/**
 * TRADE STRATEGY ENGINE
 * ========================================================================
 * Classifies the current setup into one of five strategies:
 *
 *   🟢 BUY ON DIP        — bullish trend pullback (BUY CE)
 *   🔴 SELL ON RISE      — bearish trend pullback (BUY PE)
 *   🚀 BREAKOUT BUY      — momentum break above VAH (BUY CE)
 *   🚀 BREAKDOWN BUY     — momentum break below VAL (BUY PE)
 *   🟡 RANGE MARKET      — inside value, no directional edge
 *
 * Sources: data.dashboard.tradeStrategy (computed from VWAP / FRVP /
 * dominance / delta / OI walls / premium velocity / volume surge).
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
  const isWait = ts.verdict === "WAIT";

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
      <div className="-m-1.5 flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden p-1.5">
        {/* HEADLINE — strategy label + verdict */}
        <div
          className="flex items-center gap-2 rounded-md border px-2.5 py-1.5"
          style={{ background: t.soft, borderColor: t.border }}
        >
          <span className="text-[18px] leading-none">{ts.icon}</span>
          <div className="flex flex-col">
            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/55">
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
            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/55">
              Verdict
            </span>
            <span
              className="text-[14px] font-black uppercase leading-none tracking-wider"
              style={{ color: t.color }}
            >
              {ts.verdict}
            </span>
          </div>
        </div>

        {/* TRADE BLOCK — strike + confidence */}
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
            <div
              className="rounded-md border px-2 py-1 text-center"
              style={{ borderColor: t.border, background: "rgba(255,255,255,0.02)" }}
            >
              <div className="text-[8px] font-bold uppercase tracking-[0.16em] text-white/55">Confidence</div>
              <div className="font-mono text-[18px] font-black leading-none" style={{ color: t.color }}>
                {ts.confidence}%
              </div>
            </div>
          </div>
        ) : (
          <div
            className="rounded-md border px-2.5 py-2 text-center"
            style={{ background: t.soft, borderColor: t.border }}
          >
            <div className="text-[14px] font-black uppercase tracking-wider" style={{ color: t.color }}>
              Avoid Directional Trade
            </div>
            <div className="text-[10px] text-white/65">{ts.subline}</div>
          </div>
        )}

        {/* REASONS */}
        {ts.topReasons.length > 0 ? (
          <div className="flex flex-col gap-0.5 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1">
            <span className="text-[8px] font-bold uppercase tracking-[0.16em] text-white/45">
              Reason
            </span>
            <ul className="flex flex-col gap-0.5 text-[10px] leading-tight text-white/75">
              {ts.topReasons.map((r, i) => (
                <li key={i} className="flex items-start gap-1">
                  <span className="mt-0.5 shrink-0" style={{ color: t.color }}>▸</span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* RANKED STRATEGY DOTS — visual indicator of how close other setups are */}
        <div className="flex items-center gap-1 text-[8px]">
          <span className="font-bold uppercase tracking-wider text-white/45">Ranked:</span>
          {ts.ranked.slice(0, 5).map((r, i) => {
            const isWinner = r.key === ts.key;
            const tone = r.key.includes("CE") || r.key === "BREAKOUT_CE_BUY" ? "bull"
              : r.key.includes("PE") || r.key === "BREAKDOWN_PE_BUY" ? "bear"
              : "warn";
            const tt = V2_TONE[tone];
            return (
              <span
                key={r.key}
                className="rounded-sm px-1 py-0.5 font-mono"
                style={{
                  background: isWinner ? tt.color + "22" : "transparent",
                  border: `1px solid ${isWinner ? tt.color + "55" : "rgba(255,255,255,0.08)"}`,
                  color: isWinner ? tt.color : "rgba(255,255,255,0.45)",
                  fontWeight: isWinner ? 700 : 400,
                }}
                title={`${r.key} = ${r.score}`}
              >
                {labelOf(r.key)} {r.score}
              </span>
            );
          })}
        </div>
      </div>
    </V2Card>
  );
}

// Compact label for ranked dots
function labelOf(key: string): string {
  switch (key) {
    case "BUY_ON_DIP_CE":     return "DIP";
    case "SELL_ON_RISE_PE":   return "RISE";
    case "BREAKOUT_CE_BUY":   return "BRK";
    case "BREAKDOWN_PE_BUY":  return "BKD";
    case "RANGE_MARKET":      return "RNG";
    default:                  return key;
  }
}
