/* ─────────────────────────────────────────────────────────────────────
 * INTEL V4 — Pure Buyers/Sellers Decision Engine response shape
 * ───────────────────────────────────────────────────────────────────── */

export type V4Symbol = "NIFTY_50" | "SENSEX" | "BANKNIFTY";

export interface V4SideMetric {
  oi: number;
  oiChg: number;
  ltp: number;
  iv: number;
  delta: number;
  vol: number;
  buyersPct: number;
  sellersPct: number;
  buildup: string;
  dominance: "BUYERS" | "SELLERS" | "BALANCED";
  score: number;
}

export interface V4Strike {
  strike: number;
  isAtm: boolean;
  offset: number;
  ce: V4SideMetric;
  pe: V4SideMetric;
  dominantSide: "CE" | "PE" | "BALANCED";
  strength: "WEAK" | "MODERATE" | "STRONG" | "DOMINANT";
  marketImpact: "BULLISH" | "BEARISH" | "NEUTRAL";
  note: string;
}

export interface V4Overall {
  control: "BUYERS" | "SELLERS" | "NEUTRAL";
  directionLikely: "UP" | "DOWN" | "RANGE";
  bullVotes: number;
  bearVotes: number;
  cePct: number;
  pePct: number;
  bullishFlowPct: number;
  score: number;
  confidence: number;
  grade: "A+" | "A" | "B" | "C" | "D";
  conviction: "HIGH" | "MEDIUM" | "LOW" | "AVOID";
  verdict: "BUY CE" | "BUY PE" | "WAIT";
  reasons: string[];
}

export interface V4Decision {
  ok: boolean;
  version: "v4";
  symbol: V4Symbol;
  date: string;
  isToday: boolean;
  at: number;
  spotPrice: number;
  vwap: number;
  futPremium: number;
  vix: number | null;
  atm: number | null;
  primaryStrike: number;
  step: number;
  overall: V4Overall;
  bestStrike: { strike: number; side: string; score: number; reason: string } | null;
  mostVolume: { strike: number; volume: number } | null;
  strikes: V4Strike[];
}
