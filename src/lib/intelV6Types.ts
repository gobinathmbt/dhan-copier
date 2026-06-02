/* ─────────────────────────────────────────────────────────────────────
 * INTEL V6 — NIFTY MASTER ENGINE DASHBOARD response shape
 *   GREEKS + CPR + BREADTH + IT ENGINE
 * ───────────────────────────────────────────────────────────────────── */

export type V6Symbol = "NIFTY_50" | "SENSEX" | "BANKNIFTY";
export type V6Bias = "BULLISH" | "BEARISH" | "NEUTRAL";
export type V6Tone = "strongbull" | "bull" | "neutral" | "bear" | "strongbear";

export interface V6ScaleRow {
  range: string;
  label: string;
  tone: string;
  active: boolean;
}

export interface V6MarketMode {
  label: string;
  state: "RISK ON" | "RISK OFF" | "NEUTRAL";
  bias: V6Bias;
}

export interface V6Header {
  date: string;
  time: string;
  indexName: string;
  spot: number;
  change: number;
  changePct: number;
  vix: number;
  vixChangePct: number;
  marketMode: V6MarketMode;
}

export interface V6BreadthEngine {
  advancing: number;
  declining: number;
  unchanged: number;
  total: number;
  pct: number;
  formula: string;
  zone: string;
  tone: string;
  bias: V6Bias;
  scale: V6ScaleRow[];
}

export interface V6ItEngine {
  changePct: number;
  members: Array<{ symbol: string; changePct: number }>;
  zone: string;
  tone: string;
  bias: V6Bias;
  summary: string;
  scale: V6ScaleRow[];
}

export interface V6OpeningCol {
  cond: string;
  verdict: string;
  sub: string;
  tone: string;
  active: boolean;
}

export interface V6CprEngine {
  width: { label: string; headline: string; sub: string; tone: string };
  widthPct: number;
  levels: {
    r3: number; tc: number; pivot: number; bc: number; s3: number;
    r1: number; r2: number; s1: number; s2: number;
  };
  priceLocation: string;
  territory: string;
  locationSub: string;
  locationBias: V6Bias;
  locationBanner: string;
  relation: { label: string; l1: string; l2: string; bias: V6Bias };
  opening: { gapUp: V6OpeningCol[]; flat: V6OpeningCol[]; gapDown: V6OpeningCol[] };
}

export interface V6TrendView {
  active: V6Bias;
  rows: Array<{ dir: string; label: string; l1: string; l2: string; tone: string; active: boolean }>;
}

export interface V6GreekBlock {
  value: number;
  trend: string;
  scale: V6ScaleRow[];
}

export interface V6GreeksEngine {
  delta: V6GreekBlock & { bias: V6Bias; control: string };
  gamma: V6GreekBlock & { state: string };
  vega: V6GreekBlock & { iv: number; state: string };
  theta: V6GreekBlock & { decay: string; friendly: string };
  allPositive: boolean;
  reading: Array<{ text: string; tone: string; active: boolean }>;
}

export interface V6LogicMatrix {
  rows: Array<{ engine: string; value: string; verdict: string; tone: string; greeks?: boolean }>;
  condition: string;
  conditionBias: V6Bias;
  summary: Array<{ label: string; ok: boolean }>;
  allAlign: boolean;
  alignText: string;
}

export interface V6FinalVerdict {
  setup: string;
  bias: V6Bias;
  stars: number;
  confidence: number;
  confidenceText: string;
  cells: Array<{ label: string; value: string; icon?: string; tone: string }>;
  tradePlan: string;
}

export interface V6Decision {
  ok: boolean;
  version: "v6";
  symbol: V6Symbol;
  displayName: string;
  date: string;
  isToday: boolean;
  at: number;

  header: V6Header;
  breadthEngine: V6BreadthEngine;
  itEngine: V6ItEngine;
  cprEngine: V6CprEngine;
  trendView: V6TrendView;
  greeksEngine: V6GreeksEngine;
  logicMatrix: V6LogicMatrix;
  finalVerdict: V6FinalVerdict;
  goldenRule: string;

  debug?: Record<string, unknown>;
}
