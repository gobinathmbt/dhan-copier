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
  leadership: {
    bias: V6Bias;
    label: string;
    totalImpact: number;
    alignment: string | null;
    alignLabel: string | null;
    status: "CONFIRMED" | "PARTIAL" | "DIVERGENT";
  };
  scale: V6ScaleRow[];
}

export interface V6AuctionEngine {
  poc: number;
  vah: number;
  val: number;
  spot: number;
  zone: "ABOVE VALUE" | "INSIDE VALUE" | "BELOW VALUE" | "UNKNOWN";
  bias: V6Bias;
  desc: string;
  priceAbovePocPct: number;
  acceptance: {
    acceptedAboveVah: boolean;
    acceptedBelowVal: boolean;
    rejectedAboveVah: boolean;
    rejectedBelowVal: boolean;
  };
  scale: V6ScaleRow[];
}

export interface V6FlowEngine {
  bias: V6Bias;
  label: string;
  deltaPct: number;
  futPremium: number;
  buyersPct: number;
  components: Array<{ key: string; value: string; bias: V6Bias; tone: string }>;
  desc: string;
}

export interface V6AlignmentEngine {
  count: number;
  total: number;
  dominantSide: V6Bias;
  grade: string;
  gradeLabel: string;
  tone: string;
  text: string;
  rows: Array<{ engine: string; bias: V6Bias; aligned: boolean; tone: string }>;
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
  yesterday: { tc: number; bc: number; pivot: number } | null;
  priceLocation: string;
  territory: string;
  locationSub: string;
  locationBias: V6Bias;
  locationBanner: string;
  relation: { label: string; l1: string; l2: string; bias: V6Bias; method: string };
  alignment: { label: string; strength: "STRONG" | "WEAK" | "NONE"; bias: V6Bias; desc: string };
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

export interface V6GreeksSide {
  delta: number;
  gamma: number;
  vega: number;
  iv: number;
  deltaTrend: string;
  vegaTrend: string;
  gammaTrend: string;
}

export interface V6GreeksEngine {
  side: "CE" | "PE" | "NEUTRAL";
  bias: V6Bias;
  confirm: boolean;
  dominance: {
    ceScore: number;
    peScore: number;
    ce: V6GreeksSide;
    pe: V6GreeksSide;
  };
  delta: V6GreekBlock & { bias: V6Bias; control: string };
  gamma: V6GreekBlock & { state: string };
  vega: V6GreekBlock & { iv: number; state: string };
  theta: V6GreekBlock & { decay: string; friendly: string };
  premiumExpansion: {
    score: number;
    state: "EXPANDING" | "NEUTRAL" | "DECAYING";
    side: "CE" | "PE";
    components: { delta: string; gamma: string; vega: string; theta: string };
  };
  allPositive: boolean;
  reading: Array<{ text: string; tone: string; active: boolean }>;
}

export interface V6MarketCharacter {
  label: string;
  desc: string;
  tone: string;
  inputs: {
    breadthPct: number;
    cprWidth: string;
    vix: number;
    vixChangePct: number;
    vixTrend: string;
  };
}

export interface V6LogicMatrix {
  netScore: number;
  weights: { breadth: number; cprLocation: number; cprRelation: number; it: number; greeks: number; vix: number };
  rows: Array<{ engine: string; weight: number; value: string; verdict: string; tone: string; greeks?: boolean }>;
  condition: string;
  conditionBias: V6Bias;
  summary: Array<{ label: string; ok: boolean }>;
  allAlign: boolean;
  alignText: string;
}

export interface V6FinalVerdict {
  setup: string;
  bias: V6Bias;
  greeksGate: "CONFIRMED" | "ALIGN-PENDING" | "PENDING" | "N/A";
  netScore: number;
  stars: number;
  confidence: number;
  confidenceText: string;
  quality: {
    alignment: string;
    grade: string;
    gradeLabel: string;
    premiumState: "EXPANDING" | "NEUTRAL" | "DECAYING";
    flowState: string;
    auctionZone: string;
  };
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
  auctionEngine: V6AuctionEngine;
  flowEngine: V6FlowEngine;
  trendView: V6TrendView;
  greeksEngine: V6GreeksEngine;
  marketCharacter: V6MarketCharacter;
  alignmentEngine: V6AlignmentEngine;
  logicMatrix: V6LogicMatrix;
  finalVerdict: V6FinalVerdict;
  goldenRule: string;

  debug?: Record<string, unknown>;
}
