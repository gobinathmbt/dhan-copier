/* ─────────────────────────────────────────────────────────────────────
 * INTEL V6 — Premium Intelligence (Greeks) Engine response shape
 * ───────────────────────────────────────────────────────────────────── */

export type V6Symbol = "NIFTY_50" | "SENSEX" | "BANKNIFTY";
export type V6Bias = "BULLISH" | "BEARISH" | "NEUTRAL";
export type V6Trend = "RISING" | "FALLING" | "FLAT";

export interface V6DeltaEngine {
  value: number;
  level: "STRONG" | "MODERATE" | "WEAK";
  trend: V6Trend;
  bias: "BULLISH" | "BEARISH";
  quality: "REAL" | "FAKE" | "BUILDING";
  verdict: string;
  score: number;
  narrative: string;
}

export interface V6GammaEngine {
  value: number;
  index: number;
  level: "HIGH" | "MEDIUM" | "LOW";
  trend: V6Trend;
  verdict: string;
  score: number;
  narrative: string;
}

export interface V6ThetaEngine {
  value: number;
  level: "FAST" | "MEDIUM" | "SLOW";
  trend: V6Trend;
  verdict: string;
  decayWinning: boolean;
  score: number;
  narrative: string;
}

export interface V6VegaEngine {
  value: number;
  iv: number;
  level: "RISING" | "FALLING" | "FLAT";
  state: "EXPANDING" | "CRUSH" | "STABLE";
  trend: V6Trend;
  verdict: string;
  score: number;
  narrative: string;
}

export interface V6StrikeRow {
  strike: number;
  isAtm: boolean;
  side: "CE" | "PE" | "ATM";
  dominantPct: number;
  ceFavorPct: number;
  peFavorPct: number;
  oi: number;
  oiChangePct: number;
  label: string;
}

export interface V6Decision {
  ok: boolean;
  version: "v6";
  symbol: V6Symbol;
  date: string;
  isToday: boolean;
  at: number;

  spotPrice: number;
  vwap: number;
  atm: number | null;
  futPremium: number;
  activeSide: "CE" | "PE";

  greeks: {
    delta: V6DeltaEngine;
    gamma: V6GammaEngine;
    theta: V6ThetaEngine;
    vega: V6VegaEngine;
  };

  premiumPower: {
    score: number;
    state: "NUCLEAR EXPANSION" | "STRONG EXPANSION" | "TRADEABLE" | "LOW EDGE" | "AVOID";
    buyerEdge: "YES" | "WEAK" | "NO";
    behaviour: "EXPANDING" | "NEUTRAL" | "DECAYING";
    components: { delta: number; gamma: number; vega: number; theta: number };
    weights: { delta: number; gamma: number; vega: number; theta: number };
  };

  momentumMatrix: {
    score: number;
    delta: { label: string; trend: V6Trend };
    gamma: { label: string; trend: V6Trend };
    theta: { label: string; trend: string };
    vega: { label: string; trend: V6Trend };
  };

  greeksSummary: {
    deltaTrend: V6Trend;
    gammaLevel: "HIGH" | "MEDIUM" | "LOW";
    thetaImpact: "HIGH" | "MEDIUM" | "LOW";
    vegaTrend: "EXPANDING" | "CRUSH" | "STABLE";
    premiumEdge: "HIGH" | "MEDIUM" | "LOW";
  };

  strikeDominance: {
    step: number;
    count: number;
    atm: number | null;
    strikes: V6StrikeRow[];
    bias: V6Bias;
    dominantPct: number;
    ceFavorCount?: number;
    peFavorCount?: number;
  };

  futuresBreadth: {
    futPremium: number;
    premiumState: "PREMIUM POSITIVE" | "PREMIUM NEGATIVE" | "PREMIUM FLAT";
    advDec: { adv: number; dec: number; advPct: number; decPct: number; label: string };
    sentiment: V6Bias;
  };

  session: { day: string; time: string; live: boolean; volatility: string };
  risk: { level: "LOW" | "MEDIUM" | "HIGH"; reward: "LOW" | "MEDIUM" | "HIGH" };

  structure: {
    bias: V6Bias;
    premium: "EXPANDING" | "NEUTRAL" | "DECAYING";
    dominance: V6Bias;
  };

  verdict: {
    line: string;
    headline: string;
    tradeEdge: "STRONG" | "MODERATE" | "WEAK";
  };

  actionPlan: {
    setup: string;
    action: "BUY CE" | "BUY PE" | "WAIT";
    marketBias: V6Bias;
    confidence: number;
    confidencePct: number;
    stars: number;
  };

  debug?: Record<string, unknown>;
}
