// Types mirror backend/src/services/intelV3.service.js → getSnapshot output.
// Self-contained, NOT shared with v1/v2 types.

export type IntelV3Symbol = "NIFTY_50" | "SENSEX" | "BANKNIFTY";

export type V3Tone = "bull" | "bear" | "warn" | "neutral" | "info";

export interface V3Wall {
  strike: number;
  oi: number;
  oiChange: number;
  oiChangePct: number;
  ltp: number;
  iv: number;
  delta: number;
  isAtm: boolean;
  strengthTag: "Extreme" | "Very Strong" | "Strong" | "Major" | "Moderate";
  strengthPct: number;
}

export interface V3Leg {
  ltp: number;
  oi: number;
  oiChange: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  volume: number;
  health: { state: string; score: number };
  buildup: string | null;
}

export interface V3WindowRow {
  strike: number;
  isAtm: boolean;
  ce: V3Leg;
  pe: V3Leg;
  ceScore: number;
  peScore: number;
  ceFactors: Record<string, number>;
  peFactors: Record<string, number>;
}

export interface V3Pick {
  side: "CE" | "PE";
  strike: number;
  ltp: number;
  oi: number;
  delta: number;
  iv: number;
  gamma: number;
  theta: number;
  health: { state: string; score: number };
  moneyness: string;
  score: number;
  probability: number;
  action: "STRONG BUY" | "BUY" | "CAUTIOUS BUY" | "WAIT" | "AVOID";
  label: string;
  reasoning: string;
  factors: Record<string, number>;
  targets: { t1: number; t2: number; t3: number };
  stopLoss: number;
  riskReward: number;
}

export interface IntelV3Snapshot {
  ok: boolean;
  version: "v3";
  symbol: IntelV3Symbol;
  displayName: string;
  requestedDate: string;
  date: string;
  isToday: boolean;
  fallbackUsed: boolean;
  at: number;
  market: { isOpen: boolean; phase: string; reason?: string };

  statusBar: {
    spot: { ltp: number; change: number; changePct: number };
    bias: { label: string; tone: V3Tone; subtitle: string };
    pcr: { value: number; label: string };
    trendStrength: { label: string; barFill: number };
    vwap: { label: string; value: number | null; tone: V3Tone };
    downsideUpside: { downside: number; upside: number };
    live: boolean;
    clock: string;
  };

  marketIntent: {
    smartMoneySide: string;
    ceWritersActivity: { level: string; score: number };
    peWritersActivity: { level: string; score: number };
    oiShift: string;
    trend: string;
    ivTrend: string;
  };

  bestOptionBuy: null | {
    side: "CE" | "PE";
    strike: number;
    ltp: number;
    setupTag: string;
    setupTone: V3Tone;
    label: string;
    conditions: Array<{ label: string; value: string; tone: V3Tone }>;
    targets: { t1: number; t2: number; t3: number };
    stopLoss: number;
    riskReward: number;
    probability: number;
    action: string;
  };

  shiftFlow: {
    ceOiChange: { value: number; label: string; trend: string; tone: V3Tone };
    peOiChange: { value: number; label: string; trend: string; tone: V3Tone };
    netShift:   { value: number; label: string; label2: string; tone: V3Tone };
    pcrTrend:   { value: number; label: string; tone: V3Tone };
  };

  primary: {
    atm: number | null;
    step: number;
    window: V3WindowRow[];
    ceWalls: V3Wall[];
    peWalls: V3Wall[];
  };

  picks: {
    ce: V3Pick | null;
    pe: V3Pick | null;
    primary: V3Pick | null;
  };

  trapZones: {
    bullTrap: null | {
      lo: number; hi: number;
      label: string; hint: string;
      avoidSide: "CE" | "PE";
      severity: "HIGH" | "MED" | "LOW";
    };
    bearTrap: null | {
      lo: number; hi: number;
      label: string; hint: string;
      avoidSide: "CE" | "PE";
      severity: "HIGH" | "MED" | "LOW";
    };
    overallScore: number;
    detected: number;
  };

  alternateScenario: null | {
    side: "CE" | "PE";
    strike: number;
    label: string;
    condition: string;
    targets: { t1: number; t2: number; t3: number };
  };

  smartMoneyFlow: {
    metrics: Array<{ label: string; level: string; count: number }>;
    writersActiveZone: { lo: number; hi: number; label: string };
    buyersActiveZone:  { lo: number; hi: number; label: string };
  };

  srQuickView: {
    ce: Array<{ strike: number; tag: string }>;
    pe: Array<{ strike: number; tag: string }>;
    spot: number;
  };

  trendMomentum: {
    score: number;
    direction: "BULLISH" | "BEARISH" | "NEUTRAL";
    momentum: string;
    trendStrength: string;
    needleAngle: number;
    label: string;
  };

  keyLevels: Array<{ label: string; value: number; kind: string; relation: string }>;

  confidence: {
    score: number;
    label: string;
    side: "CE" | "PE";
    pillars: Record<string, { score: number; weight: number }>;
  };

  spot: {
    ltp: number; change: number; changePct: number;
    dayHigh: number; dayLow: number; priorClose: number;
    vwap: number | null;
  };

  futures: {
    ltp: number;
    premium: number | null;
    basisState: string;
    basis: number | null;
  };

  regime: {
    regime: string;
    dayType: string;
    volatility: string;
    trendStrength?: string;
  };

  bias: {
    directionScore: number;
    overallBias: string;
    smartMoney: string;
    reasoning: string;
  };

  debug: Record<string, unknown>;
}
