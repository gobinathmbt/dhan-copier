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
  oiState?: string;
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
  wall?: {
    type: "RESISTANCE" | "SUPPORT";
    tier: string;
    tierIdx: number;
    oi: number;
    oiChange: number;
    strength: "STRONG" | "MODERATE" | "WEAK";
  } | null;
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
  window?: { above: number; below: number; expanded: boolean };
  overall: V4Overall;
  pressure?: {
    cePressure: number;
    pePressure: number;
    tilt: number;
    tiltLabel: "STRONG BULLISH" | "BULLISH" | "BALANCED" | "BEARISH" | "STRONG BEARISH";
    intensity: "LOW" | "MODERATE" | "HIGH" | "EXTREME";
    intensityPct: number;
  };
  oiTrend?: {
    ceOiAdded: number;
    ceOiUnwind: number;
    peOiAdded: number;
    peOiUnwind: number;
    ceShare: number;
    peShare: number;
    narrative: string;
    bias: "BULLISH" | "BEARISH" | "NEUTRAL";
    priceDirection: "UP" | "DOWN";
  };
  supportResistance?: {
    topResistance: { strike: number; tier: string; oi: number; oiChange: number; strength: "STRONG" | "MODERATE" | "WEAK" } | null;
    topSupport:    { strike: number; tier: string; oi: number; oiChange: number; strength: "STRONG" | "MODERATE" | "WEAK" } | null;
    walls: Array<{ strike: number; type: "RESISTANCE" | "SUPPORT"; tier: string; tierIdx: number; oi: number; oiChange: number; strength: "STRONG" | "MODERATE" | "WEAK" }>;
  };
  bestStrike: { strike: number; side: string; score: number; reason: string } | null;
  mostVolume: { strike: number; volume: number } | null;
  strikes: V4Strike[];
}
