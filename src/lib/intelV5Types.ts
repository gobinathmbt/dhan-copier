/* ─────────────────────────────────────────────────────────────────────
 * INTEL V5 — Institutional Option Buyer Verdict response shape
 * ───────────────────────────────────────────────────────────────────── */

export type V5Symbol = "NIFTY_50" | "SENSEX" | "BANKNIFTY";
export type V5Bias = "BULLISH" | "BEARISH" | "NEUTRAL";

export interface V5Layer {
  label: string;
  bias: V5Bias;
  narrative: string;
}

export interface V5Decision {
  ok: boolean;
  version: "v5";
  symbol: V5Symbol;
  date: string;
  isToday: boolean;
  at: number;

  spotPrice: number;
  vwap: number;
  avwap: number;
  futPremium: number;
  atm: number | null;

  verdict: "BUY CE" | "BUY PE" | "WAIT";
  control: "BUYERS" | "SELLERS" | "NEUTRAL";
  confidence: number;
  grade: "A+" | "A" | "B" | "C" | "D";
  conviction: "HIGH" | "MEDIUM" | "LOW" | "AVOID";
  flowScore: number;

  layers: {
    oiChange:  V5Layer & { cePct: number; pePct: number };
    oiBuildup: V5Layer;
    avwap:     V5Layer & { avwapValue: number; distance: number };
    frvp:      V5Layer & { pocValue: number | null; pocMigration: "RISING" | "FALLING" | "FLAT"; pocDrift: number; acceptance: "BUYER" | "SELLER" };
    futures:   V5Layer & { premium: number };
    cpr:       V5Layer & { pivot: number | null; tc: number | null; bc: number | null };
  };

  alignment: { bull: number; bear: number; neutral: number; total: number; aligned: number };
  waitGates: string[];

  risk: { level: "LOW" | "MEDIUM" | "HIGH" };
  trap: { label: string; count: number };
  regime: { label: string };

  levels: {
    support:    Array<{ strike: number; side: "PE"; tier: string; oi: number; oiChange: number }>;
    resistance: Array<{ strike: number; side: "CE"; tier: string; oi: number; oiChange: number }>;
    atm:        number | null;
    spot:       number;
  };

  debug?: Record<string, unknown>;
}
