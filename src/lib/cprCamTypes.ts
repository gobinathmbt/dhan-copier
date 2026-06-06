/* ─────────────────────────────────────────────────────────────────────
 * CPR + CAMARILLA POWER ENGINE — response shape
 * ───────────────────────────────────────────────────────────────────── */

export type CCSymbol = "NIFTY_50" | "SENSEX" | "BANKNIFTY";
export type CCBias = "BULLISH" | "BEARISH" | "NEUTRAL";
export type CCSignal = "BUY CE" | "BUY PE" | "WAIT";
export type CCTone = "strongbull" | "bull" | "neutral" | "bear" | "strongbear";

export interface CCCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CCHeader {
  bias: CCBias;
  dayType: "TREND DAY" | "RANGE DAY" | "EXPANSION DAY" | "NORMAL DAY";
  cprWidth: "NARROW" | "MEDIUM" | "WIDE";
  signal: CCSignal;
  signalTone: string;
}

export interface CCCprInfo {
  tc: number;
  pivot: number;
  bc: number;
  bias: CCBias;
  position: "PRICE ABOVE TC" | "PRICE BELOW BC" | "INSIDE CPR";
  width: "NARROW" | "MEDIUM" | "WIDE";
  todayVsYesterday: "HIGHER" | "LOWER" | "OVERLAPPING" | "—";
}

export interface CCCamLevel { value: number; label: string }

export interface CCCamLevels {
  r4: CCCamLevel;
  r3: CCCamLevel;
  pivot: CCCamLevel;
  s3: CCCamLevel;
  s4: CCCamLevel;
}

export interface CCCam {
  r3: number; r4: number; r5: number; r6: number;
  s3: number; s4: number; s5: number; s6: number;
  h: number; l: number; c: number; range: number;
}

export interface CCCpr {
  tc: number; bc: number; pivot: number;
  r1: number; r2: number; s1: number; s2: number;
  width: number; widthPct: number; widthClass: "narrow" | "normal" | "wide";
}

export interface CCSignalPanel {
  signal: CCSignal;
  signalTone: string;
  setupLabel: string;
  trend: "UPTREND" | "DOWNTREND" | "RANGE";
  confidence: number;
  suggestion: string;
  invalidation: string;
  targets: Array<{ name: string; value: number }>;
  riskReward: number;
}

export interface CCMarketStrength {
  buyersPct: number;
  sellersPct: number;
  marketControl: "BUYERS" | "SELLERS" | "BALANCED";
}

export interface CCLogicCard {
  title: string;
  items: Array<{ label: string; ok: boolean }>;
  action: CCSignal;
  actionTone: string;
  score: number;
  fired: boolean;
}

export interface CCTrendContextRow {
  label: string;
  value: number;
  relation: "ABOVE" | "BELOW";
  tone: string;
}

export interface CCMarketStats {
  ltp: number;
  ltpChange: number;
  ltpChangePct: number;
  dayHigh: number;
  dayLow: number;
  change: number;
  changePct: number;
  volumeLakhs: number;
  oiChangePct: number;
  vwap: number;
  marketOpen: boolean;
  marketLabel: "MARKET OPEN" | "MARKET CLOSED";
}

export interface CCDayTypeGuideRow {
  key: "NARROW CPR" | "WIDE CPR";
  tone: string;
  headline: string;
  desc: string;
  active: boolean;
}

export interface CCKeyLevelsSummary {
  cpr: Array<{ name: string; value: number; tone: string }>;
  cam: Array<{ name: string; value: number; tone: string }>;
}

export interface CCScenarioRow {
  id: number;
  icon: string;
  cond: string;
  result: string;
  action: string;
  tone: string;
  active: boolean;
}

export interface CCTradeSetup {
  setup: string;
  action: string;
  target: string;
  stoploss: string;
  tone: string;
}

export interface CCConfluenceCheck {
  items: Array<{ label: string; ok: boolean }>;
  score: number;
  total: number;
  label: string;
  tone: string;
}

export interface CprCamResponse {
  ok: boolean;
  version: "cpr-cam-v1";
  symbol: CCSymbol;
  displayName: string;
  date: string;
  isToday: boolean;
  at: number;
  source: "live" | "folder";
  interval?: string;

  spot: number;
  spotChange: number;
  spotChangePct: number;
  dayHigh: number;
  dayLow: number;
  priorClose: number;

  header: CCHeader;
  cprInfo: CCCprInfo;
  camLevels: CCCamLevels;
  cam: CCCam;
  cpr: CCCpr;
  yesterday: { tc: number; bc: number; pivot: number } | null;

  zone: "ABOVE R4" | "ABOVE R3" | "ABOVE TC" | "INSIDE CPR" | "BELOW BC" | "BELOW S3" | "BELOW S4" | "UNKNOWN";
  status: string;
  statusTone: string;
  strengthLabel: string;

  signalPanel: CCSignalPanel;
  marketStrength: CCMarketStrength;

  logicCards: CCLogicCard[];

  flowMap: Array<{ name: string; value: number }>;
  flowIdeal: string;
  trendContext: CCTrendContextRow[];
  quickSummary: Array<{ ok: boolean; label: string }>;
  chartCandles: CCCandle[];

  marketStats: CCMarketStats;
  dayTypeGuide: CCDayTypeGuideRow[];
  keyLevelsSummary: CCKeyLevelsSummary;
  scenarioGuide: CCScenarioRow[];
  tradeSetup: CCTradeSetup;
  confluenceCheck: CCConfluenceCheck;

  desc: string;
  error?: string;
}
