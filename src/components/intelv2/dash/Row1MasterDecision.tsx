import type { IntelV2Snapshot } from "@/lib/intelV2Types";
import { V2_TONE } from "./common";

/**
 * Row 1 — Top quote ribbon
 * ========================================================================
 * Eight institutional quote tiles (replaces the legacy MARKET REGIME / SMART
 * MONEY / FUTURES / PREMIUM / DELTA / TRAP / TRADE ACTION / CONFIDENCE row):
 *
 *   1. NIFTY              — spot LTP + intraday change %
 *   2. NIFTY FUT          — futures LTP + premium / discount tag
 *   3. SENSEX             — Yahoo BSE close (best-effort)
 *   4. GIFT NIFTY         — Yahoo NSEI proxy + change %
 *   5. MAX PAIN           — option chain max-pain strike
 *   6. PCR (CE/PE)        — total CE / total PE OI ratio
 *   7. INDIA VIX          — Yahoo IndiaVIX live
 *   8. ATM IV             — implied vol of the at-the-money strike
 */
export function Row1MasterDecision({ data }: { data: IntelV2Snapshot | null }) {
  const symbol = data?.symbol || "NIFTY_50";
  const symbolLabel = symbol === "NIFTY_50" ? "NIFTY"
    : symbol === "BANKNIFTY" ? "BANKNIFTY" : "SENSEX";

  // ── 1. Index Spot ──────────────────────────────────────────
  const spot = data?.spot.ltp ?? null;
  const spotChange = data?.spot.change ?? 0;
  const spotChangePct = data?.spot.changePct ?? 0;
  const spotTone = spotChange >= 0 ? "bull" : "bear";

  // ── 2. Index Futures ───────────────────────────────────────
  const fut = data?.futures.ltp ?? null;
  const futPremium = data?.futures.premium ?? null;
  const futChange = (fut != null && data?.spot?.priorClose) ? fut - data.spot.priorClose : 0;
  const futChangePct = data?.spot?.priorClose ? (futChange / data.spot.priorClose) * 100 : 0;
  const futTone = futPremium == null ? "neutral" : futPremium >= 0 ? "bull" : "bear";

  // ── 3. SENSEX (from Yahoo macro) ───────────────────────────
  const sensex = data?.macro?.sensex ?? null;
  const sensexTone = (sensex?.changePct ?? 0) >= 0 ? "bull" : "bear";

  // ── 4. Gift Nifty (Yahoo NSEI proxy) ───────────────────────
  const gift = data?.macro?.giftNifty ?? null;
  const giftTone = (gift?.changePct ?? 0) >= 0 ? "bull" : "bear";

  // ── 5. Max Pain ─────────────────────────────────────────────
  const maxPain = data?.options.maxPain ?? null;
  const mpDistance = (maxPain != null && spot != null) ? maxPain - spot : null;
  const mpTone = mpDistance == null ? "neutral"
    : Math.abs(mpDistance) <= 50 ? "warn"
    : mpDistance > 0 ? "bull" : "bear";

  // ── 6. PCR ──────────────────────────────────────────────────
  const pcr = data?.flow.oi.pcr ?? 0;
  const pcrTone = pcr >= 1.05 ? "bull" : pcr <= 0.95 ? "bear" : "warn";
  const pcrLabel = pcr >= 1.15 ? "Bullish" : pcr >= 1.05 ? "Mild Bull"
    : pcr <= 0.85 ? "Bearish" : pcr <= 0.95 ? "Mild Bear" : "Neutral";

  // ── 7. India VIX ────────────────────────────────────────────
  const vix = data?.macro?.vix ?? null;
  const vixTone = (vix?.changePct ?? 0) >= 5 ? "bear"
    : (vix?.changePct ?? 0) >= 0 ? "warn"
    : (vix?.changePct ?? 0) <= -5 ? "bull" : "neutral";
  const vixLabel = (vix?.price ?? 0) >= 18 ? "Elevated"
    : (vix?.price ?? 0) >= 14 ? "Normal"
    : (vix?.price ?? 0) > 0 ? "Low" : "—";

  // ── 8. ATM IV ───────────────────────────────────────────────
  const atmIv = data?.options.atmIv ?? 0;
  const atmIvTone = atmIv >= 25 ? "bear" : atmIv >= 18 ? "warn" : atmIv >= 10 ? "bull" : "neutral";
  const atmIvLabel = atmIv >= 25 ? "Expensive" : atmIv >= 18 ? "Premium" : atmIv >= 10 ? "Healthy" : atmIv > 0 ? "Dead" : "—";

  return (
    <div className="grid h-[110px] grid-cols-8 gap-2">
      <QuoteTile
        label={symbolLabel}
        primary={fmt(spot, 2)}
        change={spotChange}
        changePct={spotChangePct}
        tone={spotTone}
      />
      <QuoteTile
        label={`${symbolLabel} FUT`}
        primary={fmt(fut, 2)}
        change={futChange}
        changePct={futChangePct}
        sub={futPremium != null
          ? `${futPremium >= 0 ? "Premium" : "Discount"} ${signed(futPremium, 2)}`
          : "—"}
        tone={futTone}
      />
      <QuoteTile
        label="SENSEX"
        primary={sensex ? fmt(sensex.price, 2) : "—"}
        changePct={sensex?.changePct ?? 0}
        tone={sensexTone}
        ifMissing={!sensex}
      />
      <QuoteTile
        label="GIFT NIFTY"
        primary={gift ? fmt(gift.price, 2) : "—"}
        changePct={gift?.changePct ?? 0}
        tone={giftTone}
        ifMissing={!gift}
      />
      <QuoteTile
        label="MAX PAIN"
        primary={maxPain ? fmt(maxPain, 0) : "—"}
        sub={mpDistance != null
          ? `${mpDistance > 0 ? "Above" : "Below"} Spot · ${signed(mpDistance, 0)}`
          : "—"}
        tone={mpTone}
      />
      <QuoteTile
        label="PCR (CE/PE)"
        primary={pcr ? pcr.toFixed(2) : "—"}
        sub={pcrLabel}
        tone={pcrTone}
      />
      <QuoteTile
        label="INDIA VIX"
        primary={vix ? fmt(vix.price, 2) : "—"}
        changePct={vix?.changePct ?? 0}
        sub={vixLabel}
        tone={vixTone}
        ifMissing={!vix}
      />
      <QuoteTile
        label="ATM IV"
        primary={atmIv ? `${atmIv.toFixed(1)}%` : "—"}
        sub={atmIvLabel}
        tone={atmIvTone}
      />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Quote tile primitive — uniform compact card with label, value,
 * change pct, and a sub-label.
 * ───────────────────────────────────────────────────────────────── */
function QuoteTile({
  label, primary, change, changePct, sub, tone, ifMissing,
}: {
  label: string;
  primary: string;
  change?: number;
  changePct?: number;
  sub?: string;
  tone: "bull" | "bear" | "warn" | "neutral" | "info";
  ifMissing?: boolean;
}) {
  const t = V2_TONE[tone];
  const showChangePct = changePct != null && Number.isFinite(changePct);
  const arrow = (changePct ?? 0) > 0 ? "▲" : (changePct ?? 0) < 0 ? "▼" : "▬";
  return (
    <div
      className="flex h-full flex-col rounded-md border bg-[#0e1117] px-2.5 py-2"
      style={{ borderColor: t.border, background: ifMissing ? "rgba(255,255,255,0.02)" : t.soft }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-bold uppercase tracking-[0.16em] text-white/55">{label}</span>
        {showChangePct ? (
          <span
            className="rounded-sm px-1 py-0.5 text-[9px] font-bold tabular-nums"
            style={{ background: t.soft, color: t.color }}
          >
            {arrow} {(changePct! >= 0 ? "+" : "")}{changePct!.toFixed(2)}%
          </span>
        ) : null}
      </div>
      <div
        className="mt-0.5 font-mono text-[18px] font-black leading-none tabular-nums"
        style={{ color: ifMissing ? "rgba(255,255,255,0.45)" : "#f1f5f9" }}
      >
        {primary}
      </div>
      <div className="mt-auto flex items-center justify-between">
        {change != null && Number.isFinite(change) ? (
          <span className="text-[10px] font-mono tabular-nums" style={{ color: t.color }}>
            {change >= 0 ? "+" : ""}{change.toFixed(2)}
          </span>
        ) : <span />}
        {sub ? (
          <span
            className="truncate text-[10px] font-bold uppercase tracking-wider"
            style={{ color: t.color }}
          >
            {sub}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function fmt(n: number | null | undefined, d = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function signed(n: number, d = 2): string {
  return `${n >= 0 ? "+" : ""}${fmt(n, d)}`;
}
