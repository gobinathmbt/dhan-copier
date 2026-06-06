/* ─────────────────────────────────────────────────────────────────────
 * ORDER FLOW INTEL ENGINE — response shape
 * ───────────────────────────────────────────────────────────────────── */

export type OFSymbol = "NIFTY_50" | "SENSEX" | "BANKNIFTY";
export type OFBias = "BULLISH" | "BEARISH" | "NEUTRAL";
export type OFTone = "strongbull" | "bull" | "neutral" | "bear" | "strongbear";
export type OFSide = "BUY" | "SELL" | "FLAT";
export type OFAction = "BUY CE" | "BUY PE" | "WAIT";

export interface OFScaleRow {
  range: string;
  label: string;
  tone: string;
  active: boolean;
}

export interface OFAggression {
  buyVol: number;
  sellVol: number;
  buyDomPct: number;
  sellDomPct: number;
  side: "BUYERS" | "SELLERS" | "BALANCED";
  verdict: string;
  tone: string;
}

export interface OFDelta {
  value: number;
  pct: number;
  buyVol: number;
  sellVol: number;
  side: "BUYERS" | "SELLERS" | "BALANCED";
  verdict: string;
  tone: string;
}

export interface OFCard {
  state?: string;
  side?: string;
  tone: string;
  verdict: string;
  desc?: string;
  score?: number;
  // Trap-only:
  label?: string;
  probabilityBuyer?: number;
  probabilitySeller?: number;
}

export interface OFPremiumAccept extends OFCard {
  spotDelta?: number;
  atmCeDelta?: number;
  atmPeDelta?: number;
  cePctMove?: number;
  pePctMove?: number;
}

export interface OFFlowAlignmentRow {
  spot: OFSide;
  ce: OFSide;
  pe: OFSide;
  verdict: string;
  tone: string;
  active: boolean;
}

export interface OFFlowAlignment {
  spot: OFSide;
  ce: OFSide;
  pe: OFSide;
  ceBuyersPct: number;
  peBuyersPct: number;
  verdict: string;
  tone: string;
  score: number;
  desc: string;
  rows: OFFlowAlignmentRow[];
}

export interface OFFootprint extends OFCard {
  signal?: string;
  frvpZone?: string;
  deltaTrend?: "RISING" | "FALLING" | "FLAT";
  absorptionSignal?: string;
  activity?: string;
}

export interface OFScoreBreakdown {
  buyerAggression:    { score: number; weight: number };
  sellerAbsorption:   { score: number; weight: number };
  premiumAcceptance:  { score: number; weight: number };
  flowAlignment:      { score: number; weight: number };
}

export interface OFReversal {
  bullishProb: number;
  bearishProb: number;
  bias: OFBias;
  label: string;
  tone: string;
  desc: string;
}

export interface OFStrikeLeg {
  ltp: number;
  oi: number;
  oiChange: number;
  volume: number;
  premPct: number;
  oiPct: number;
  score: number;
}

export interface OFStrikeRow {
  strike: number;
  isAtm: boolean;
  isAtmRound: boolean;
  offset: number;
  moneynessCe: "ITM" | "OTM" | "ATM";
  moneynessPe: "ITM" | "OTM" | "ATM";
  ce: OFStrikeLeg;
  pe: OFStrikeLeg;
  action: OFAction;
  actionTone: string;
  reversalProb: number;
  reasoning: string;
}

export interface OFDecision {
  action: OFAction;
  tone: string;
  ceWinners: number;
  peWinners: number;
  ceShare: number;
  peShare: number;
  summary: string;
}

export interface OrderFlowResponse {
  ok: boolean;
  version: "order-flow-v1";
  symbol: OFSymbol;
  displayName: string;
  date: string;
  isToday: boolean;
  at: number;
  source: "live" | "folder";
  spot: number;
  spotChange: number;
  spotChangePct: number;
  vwap: number;
  cprTc: number;
  cprBc: number;
  atm: number;
  anchor: number;
  step: number;
  auctionZone: string;
  poc: number;
  vah: number;
  val: number;
  score: number;
  weightedScore: number;
  buyerPower: number;
  sellerPower: number;
  bias: OFBias;
  side: "CE" | "PE" | "NEUTRAL";
  state: string;
  tone: string;
  verdict: string;
  cumDelta: number;
  cumDeltaTrend: "RISING" | "FALLING" | "FLAT";
  aggression: OFAggression;
  delta: OFDelta;
  absorption: OFCard;
  exhaustion: OFCard;
  trap: OFCard;
  premiumAccept: OFPremiumAccept;
  flowAlignment: OFFlowAlignment;
  footprint: OFFootprint;
  scoreBreakdown: OFScoreBreakdown;
  reversal: OFReversal;
  strikes: OFStrikeRow[];
  decision: OFDecision;
  ready: boolean;
  historyDepth?: number;
  baselineAgeSec?: number;
  desc: string;
  scale: OFScaleRow[];
  error?: string;
}
