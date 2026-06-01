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
  breadth?: {
    advancing: number | null;
    declining: number | null;
    advancePct: number | null;
  };
  // ── V5-grade institutional engines ────────────────────────────────
  engines?: {
    oiVelocity:        { value: number; label: "AGGRESSIVE" | "STRONG" | "NORMAL" | "QUIET"; score: number; ageMin: number };
    volumeVelocity:    { ratio: number; label: "AGGRESSIVE" | "INSTITUTIONAL" | "STRONG" | "NORMAL" | "QUIET"; score: number; totalNow: number };
    vwapAcceptance:    { sideMin: number; side: "ABOVE" | "BELOW"; score: number; label: string };
    wallStability:     { resistanceAgeMin: number; supportAgeMin: number; avgAgeMin: number; score: number; label: "ROCK SOLID" | "STABLE" | "FORMING" | "NEW" };
    strikeMigration:   { resDirection: "RISING" | "FALLING" | "STABLE"; supDirection: "RISING" | "FALLING" | "STABLE"; bias: "BULLISH" | "BEARISH" | "NEUTRAL"; score: number; resDelta?: number; supDelta?: number };
    ivTrend:           { ivChangePct: number; label: "EXPANDING" | "CONTRACTING" | "FLAT"; score: number };
    gex:               { netGex: number; regime: "POSITIVE_GAMMA" | "NEGATIVE_GAMMA"; topGexStrike: number | null; score: number; interpretation: string };
    dex:               { ceDex: number; peDex: number; netDex: number; skewPct: number; bias: "CE_HEAVY" | "PE_HEAVY" | "BALANCED" };
    absorption:        { detected: boolean; priceChgPct?: number; label: string; score: number };
    exhaustion:        { detected: boolean; label: string; score: number; volFading?: boolean; oiContracting?: boolean };
    pcWallRatio:       { pe: number; ce: number; ratio: number; bias: "BULLISH FLOOR" | "BEARISH CEILING" | "BALANCED" };
    expectedMove:      { sigma: number; upperBand: number; lowerBand: number; location: "WITHIN" | "NEAR_UPPER" | "NEAR_LOWER" | "ABOVE_UPPER" | "BELOW_LOWER" } | null;
    mtfConfirm:        { reads: Array<{ tf: number; valid: boolean; bias: string }>; bull: number; bear: number; aligned: number; score: number; label: string };
    instParticipation: { score: number; label: "EXTREME" | "HIGH" | "MODERATE" | "LOW" };
  };
  weights?: Record<string, { weight: number; score: number; aligned: number }>;
  trapBlockers?: string[];
  bestStrike: { strike: number; side: string; score: number; reason: string } | null;
  mostVolume: { strike: number; volume: number } | null;
  strikes: V4Strike[];
}
