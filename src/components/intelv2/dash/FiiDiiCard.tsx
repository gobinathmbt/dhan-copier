import type { IntelV2Snapshot } from "@/lib/intelV2Types";
import { V2Card, V2_TONE } from "./common";

/**
 * 🏦 SMART MONEY FLOW (FII · DII · PRO · CLIENT)
 * ========================================================================
 * 3-section layout (final spec):
 *   1. FUTURES        — Participant · Date · Buy OI · Sell OI · Net OI · Overall Bias
 *   2. INDEX OPTIONS  — Participant · Date · Call Buy OI · Call Sell OI · Call Net OI · Put Buy OI · Put Sell OI · Put Net OI · Overall Bias
 *   3. OVERALL BIAS   — Institutional Bias verdict · Reason bullets · Market Interpretation arrows
 *
 * Sensibull source notes:
 *  • Futures publishes only NET OI (no buy/sell split) → Buy/Sell show "—"
 *  • Options publishes long.oi_change (Buy) + short.oi_change (Sell). Net OI:
 *      - if both Buy and Sell are present → render their difference (today's delta)
 *      - else → fall back to overall `net_oi` (cumulative position)
 *  • Bias = view + strength → "Medium Bearish", "Strong Bullish", "Mild Bearish", "Indecisive"
 */
export function FiiDiiCard({ data }: { data: IntelV2Snapshot | null }) {
  const fd = data?.macro?.fiiDii;

  if (!fd) {
    return (
      <V2Card title="🏦 Smart Money Flow">
        <div className="flex h-full items-center justify-center text-[12px] text-white/40">
          Awaiting Sensibull feed…
        </div>
      </V2Card>
    );
  }

  // ── Sensibull shapes ────────────────────────────────────────────────────
  type FutureLeg = {
    "quantity-wise"?: {
      net_oi?: number;
      outstanding_oi?: number;
      net_action?: string;
      net_view?: string;
      net_view_strength?: string;
    };
  };
  type OptionSide = {
    long?: { oi_current?: number; oi_change?: number };
    short?: { oi_current?: number; oi_change?: number };
    net_oi?: number;
    net_oi_change?: number;
    net_oi_change_view?: string;
    net_oi_change_view_strength?: string;
  };
  type OptionLeg = {
    call?: OptionSide;
    put?: OptionSide;
    overall_net_oi?: number;
    overall_net_oi_change?: number;
    overall_net_oi_change_view?: string;
    overall_net_oi_change_view_strength?: string;
  };

  type Player = "FII" | "PRO" | "CLIENT" | "DII";
  const players: Player[] = ["FII", "PRO", "CLIENT", "DII"];

  const fut = (p: Player): FutureLeg | undefined =>
    (fd.future as Record<string, FutureLeg | undefined> | undefined)?.[p.toLowerCase()];
  const opt = (p: Player): OptionLeg | undefined =>
    (fd.option as Record<string, OptionLeg | undefined> | undefined)?.[p.toLowerCase()];

  // ── Helpers ─────────────────────────────────────────────────────────────
  const fmt = (n?: number): string => {
    if (n == null || !Number.isFinite(n) || n === 0) return "—";
    const a = Math.abs(n);
    const sign = n < 0 ? "-" : "";
    if (a >= 1e7) return `${sign}${(a / 1e7).toFixed(2)} Cr`;
    if (a >= 1e5) return `${sign}${(a / 1e5).toFixed(2)} L`;
    if (a >= 1e3) return `${sign}${Math.round(a).toLocaleString("en-IN")}`;
    return `${sign}${Math.round(a)}`;
  };
  const fmtSigned = (n?: number): string => {
    if (n == null || !Number.isFinite(n) || n === 0) return "—";
    const f = fmt(Math.abs(n));
    return n > 0 ? `+${f}` : `-${f}`;
  };
  const colorOf = (n?: number): string => {
    if (n == null || !Number.isFinite(n) || n === 0) return "rgba(255,255,255,0.55)";
    return n > 0 ? V2_TONE.bull.color : V2_TONE.bear.color;
  };
  const viewTone = (view?: string): "bull" | "bear" | "warn" =>
    view === "BULLISH" ? "bull" : view === "BEARISH" ? "bear" : "warn";
  const viewLabel = (view?: string, strength?: string): string => {
    if (!view) return "Indecisive";
    const v = view.charAt(0) + view.slice(1).toLowerCase();
    return strength ? `${strength} ${v}` : v;
  };

  // For options: derive a per-side row that respects "—" rendering rules.
  const optSideRow = (side?: OptionSide) => {
    const buy = side?.long?.oi_change ?? 0;
    const sell = side?.short?.oi_change ?? 0;
    const hasBuy = buy !== 0;
    const hasSell = sell !== 0;
    let net: number;
    if (hasBuy && hasSell) net = buy - sell;
    else if (side?.net_oi != null && side?.net_oi !== 0) net = side.net_oi;
    else net = side?.net_oi_change ?? 0;
    return { buy, sell, net, hasBuy, hasSell };
  };

  // ── Drive Section 3 (OVERALL BIAS) from FII anchor + cross checks ──────
  const fiiQ = fut("FII")?.["quantity-wise"];
  const fiiOpt = opt("FII");
  const fiiFutView = fiiQ?.net_view;
  const fiiFutStrength = fiiQ?.net_view_strength;
  const fiiOptView = fiiOpt?.overall_net_oi_change_view;
  const fiiOptStrength = fiiOpt?.overall_net_oi_change_view_strength;
  const fiiCallView = fiiOpt?.call?.net_oi_change_view;
  const fiiCallNet = fiiOpt?.call?.net_oi_change ?? 0;

  const proFutView = fut("PRO")?.["quantity-wise"]?.net_view;
  const proOptView = opt("PRO")?.overall_net_oi_change_view;
  const clientFutView = fut("CLIENT")?.["quantity-wise"]?.net_view;
  const clientFutStrength = fut("CLIENT")?.["quantity-wise"]?.net_view_strength;

  const fiiBullish = fiiFutView === "BULLISH" && fiiOptView === "BULLISH";
  const fiiBearish = fiiFutView === "BEARISH" || fiiOptView === "BEARISH";
  const flow: "BULLISH" | "BEARISH" | "NEUTRAL" =
    fiiBullish ? "BULLISH" : fiiBearish ? "BEARISH" : "NEUTRAL";
  const flowTone: "bull" | "bear" | "warn" =
    flow === "BULLISH" ? "bull" : flow === "BEARISH" ? "bear" : "warn";

  // Anchor verdict: take FII futures view + strength as the institutional headline.
  const anchorView = fiiFutView ?? fiiOptView;
  const anchorStrength = fiiFutStrength ?? fiiOptStrength;
  const verdictLabel = viewLabel(anchorView, anchorStrength);
  const verdictIcon = anchorView === "BULLISH" ? "🟢" : anchorView === "BEARISH" ? "🔴" : "🟡";

  // Reason bullets — auto-built from per-segment views.
  const reasons: string[] = [];
  if (fiiFutView === "BEARISH") reasons.push("FII Futures Net OI negative");
  else if (fiiFutView === "BULLISH") reasons.push("FII Futures Net OI positive");
  if (fiiOptView === "BEARISH") reasons.push("FII Index Options Net OI bearish");
  else if (fiiOptView === "BULLISH") reasons.push("FII Index Options Net OI bullish");
  if (fiiCallView === "BEARISH" && fiiCallNet < 0) reasons.push("CE-side institutional pressure active");
  else if (fiiCallView === "BULLISH" && fiiCallNet > 0) reasons.push("CE-side institutional unwinding active");
  if (proFutView && proOptView && proFutView !== proOptView) reasons.push("PRO positioning mixed");
  else if (proFutView === "BULLISH") reasons.push("PRO money mildly bullish");
  else if (proFutView === "BEARISH") reasons.push("PRO money cautious / bearish");
  const fiiVsClientOpposing =
    (fiiFutView === "BEARISH" && clientFutView === "BULLISH") ||
    (fiiFutView === "BULLISH" && clientFutView === "BEARISH");
  if (fiiVsClientOpposing) {
    reasons.push(
      `Clients aggressively ${clientFutView === "BULLISH" ? "bullish" : "bearish"} (contrarian risk)`,
    );
  }

  // Market Interpretation — directional playbook.
  const playbook: string[] = [];
  if (flow === "BEARISH") {
    playbook.push("SELL ON RISE preferred");
    playbook.push("PE buying favorable near resistance rejection");
    playbook.push("Avoid weak CE momentum trades");
  } else if (flow === "BULLISH") {
    playbook.push("BUY ON DIP preferred");
    playbook.push("CE buying favorable on support holds");
    playbook.push("Avoid late PE chasing into bounces");
  } else {
    playbook.push("RANGE TRADE — fade extremes inside value");
    playbook.push("Wait for institutional alignment");
    playbook.push("Avoid directional carry");
  }

  return (
    <V2Card
      title={
        <span className="flex items-center gap-2">
          <span>🏦</span>
          <span>Smart Money Flow</span>
          <span className="text-[10px] font-normal text-white/45">(FII · DII · PRO · CLIENT)</span>
        </span>
      }
    >
      <div className="-m-1.5 flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-1.5 pr-2">
        {/* ============ SECTION 1 — FUTURES ============ */}
        <SectionTitle title="FUTURES" date={fd.date} />
        <div className="overflow-hidden rounded-md border border-white/[0.10]">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-white/[0.10] bg-white/[0.06] text-[10px] font-bold uppercase tracking-[0.14em] text-white/65">
                <th className="px-3 py-2 text-left">Participant</th>
                <th className="px-2 py-2 text-left">Date</th>
                <th className="px-2 py-2 text-right">Buy OI</th>
                <th className="px-2 py-2 text-right">Sell OI</th>
                <th className="px-2 py-2 text-right">Net OI</th>
                <th className="px-3 py-2 text-right">Overall Bias</th>
              </tr>
            </thead>
            <tbody>
              {players.map((p, i) => {
                const q = fut(p)?.["quantity-wise"];
                const net = q?.net_oi ?? 0;
                const view = q?.net_view;
                const strength = q?.net_view_strength;
                return (
                  <tr key={p} className={i % 2 === 0 ? "bg-white/[0.02]" : "bg-white/[0.05]"}>
                    <td className="px-3 py-2.5 text-[12px] font-bold uppercase tracking-wider text-white/95">{p}</td>
                    <td className="px-2 py-2.5 font-mono text-[10px] text-white/55">{fd.date}</td>
                    <td className="px-2 py-2.5 text-right font-mono text-[11px] text-white/35">—</td>
                    <td className="px-2 py-2.5 text-right font-mono text-[11px] text-white/35">—</td>
                    <td
                      className="px-2 py-2.5 text-right font-mono text-[12px] font-bold tabular-nums"
                      style={{ color: colorOf(net) }}
                    >
                      {fmtSigned(net)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <ViewPill view={view} strength={strength} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* ============ SECTION 2 — INDEX OPTIONS ============ */}
        <SectionTitle title="INDEX OPTIONS" date={fd.date} />
        <div className="overflow-hidden rounded-md border border-white/[0.10]">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-white/[0.10] bg-white/[0.06] text-[10px] font-bold uppercase tracking-[0.14em] text-white/65">
                <th className="px-2.5 py-2 text-left">Participant</th>
                <th className="px-2 py-2 text-left">Date</th>
                <th className="px-2 py-2 text-right">Call Buy OI</th>
                <th className="px-2 py-2 text-right">Call Sell OI</th>
                <th className="px-2 py-2 text-right">Call Net OI</th>
                <th className="px-2 py-2 text-right">Put Buy OI</th>
                <th className="px-2 py-2 text-right">Put Sell OI</th>
                <th className="px-2 py-2 text-right">Put Net OI</th>
                <th className="px-2.5 py-2 text-right">Overall Bias</th>
              </tr>
            </thead>
            <tbody>
              {players.map((p, i) => {
                const o = opt(p);
                const c = optSideRow(o?.call);
                const pu = optSideRow(o?.put);
                const view = o?.overall_net_oi_change_view;
                const strength = o?.overall_net_oi_change_view_strength;
                return (
                  <tr key={p} className={i % 2 === 0 ? "bg-white/[0.02]" : "bg-white/[0.05]"}>
                    <td className="px-2.5 py-2.5 text-[12px] font-bold uppercase tracking-wider text-white/95">{p}</td>
                    <td className="px-2 py-2.5 font-mono text-[10px] text-white/55">{fd.date}</td>
                    <td className="px-2 py-2.5 text-right font-mono text-[11px] tabular-nums text-white/85">{c.hasBuy ? fmt(c.buy) : <span className="text-white/35">—</span>}</td>
                    <td className="px-2 py-2.5 text-right font-mono text-[11px] tabular-nums text-white/85">{c.hasSell ? fmt(c.sell) : <span className="text-white/35">—</span>}</td>
                    <td
                      className="px-2 py-2.5 text-right font-mono text-[12px] font-bold tabular-nums"
                      style={{ color: colorOf(c.net) }}
                    >
                      {fmtSigned(c.net)}
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono text-[11px] tabular-nums text-white/85">{pu.hasBuy ? fmt(pu.buy) : <span className="text-white/35">—</span>}</td>
                    <td className="px-2 py-2.5 text-right font-mono text-[11px] tabular-nums text-white/85">{pu.hasSell ? fmt(pu.sell) : <span className="text-white/35">—</span>}</td>
                    <td
                      className="px-2 py-2.5 text-right font-mono text-[12px] font-bold tabular-nums"
                      style={{ color: colorOf(pu.net) }}
                    >
                      {fmtSigned(pu.net)}
                    </td>
                    <td className="px-2.5 py-2.5 text-right">
                      <ViewPill view={view} strength={strength} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* ============ SECTION 3 — OVERALL BIAS ============ */}
        <SectionTitle title="OVERALL BIAS" />
        <div
          className="flex flex-col gap-2.5 rounded-md border px-3.5 py-2.5"
          style={{ borderColor: V2_TONE[flowTone].border, background: V2_TONE[flowTone].soft }}
        >
          {/* Institutional Bias verdict line */}
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-bold uppercase tracking-wider text-white/70">
              Institutional Bias
            </span>
            <span
              className="rounded-sm px-2.5 py-1 text-[13px] font-bold uppercase tracking-wider"
              style={{ background: `${V2_TONE[flowTone].color}22`, color: V2_TONE[flowTone].color }}
            >
              {verdictIcon} {verdictLabel}
            </span>
          </div>

          {/* Reason bullets */}
          <div>
            <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-white/55">
              Reason:
            </div>
            <ul className="flex flex-col gap-1 text-[12px] leading-snug text-white/85">
              {reasons.map((r, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="mt-0.5 shrink-0" style={{ color: V2_TONE[flowTone].color }}>
                    •
                  </span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Market Interpretation arrows */}
          <div>
            <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-white/55">
              Market Interpretation:
            </div>
            <ul className="flex flex-col gap-1 text-[12px] leading-snug text-white/90">
              {playbook.map((line, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="mt-0.5 shrink-0" style={{ color: V2_TONE[flowTone].color }}>
                    →
                  </span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Hidden anchor — keeps unused vars referenced (CLIENT strength + flow icon) */}
          <span className="hidden">{clientFutStrength ?? ""}</span>
        </div>
      </div>
    </V2Card>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * Section title strip
 * ───────────────────────────────────────────────────────────────────── */
function SectionTitle({ title, date }: { title: string; date?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-sky-500/25 pb-1">
      <span className="text-[12px] font-bold uppercase tracking-[0.18em] text-sky-300">{title}</span>
      {date ? <span className="font-mono text-[11px] text-white/55">{date}</span> : null}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * View pill — "BEARISH" + "Medium" → "Medium Bearish"
 * ───────────────────────────────────────────────────────────────────── */
function ViewPill({
  view,
  strength,
}: {
  view?: string;
  strength?: string;
}) {
  if (!view) {
    return (
      <span className="inline-flex items-center rounded-sm border border-white/15 bg-white/[0.05] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white/55">
        Indecisive
      </span>
    );
  }
  const tone = view === "BULLISH" ? "bull" : view === "BEARISH" ? "bear" : "warn";
  const t = V2_TONE[tone];
  const v = view.charAt(0) + view.slice(1).toLowerCase();
  const label = strength ? `${strength} ${v}` : v;
  return (
    <span
      className="inline-flex items-center rounded-sm px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider"
      style={{ background: `${t.color}22`, color: t.color, border: `1px solid ${t.border}` }}
    >
      {label}
    </span>
  );
}
