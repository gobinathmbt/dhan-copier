// TypeScript types mirroring backend/src/services/intel.service.js getSnapshot output.

export type SymbolKey = "NIFTY_50" | "SENSEX" | "BANKNIFTY";

export type Action = "BUY_CE" | "BUY_PE" | "WAIT" | "NO_TRADE";

export type Bias = "bullish" | "bearish" | "neutral";

export interface IntelSparkCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface LadderRow {
  strike: number;
  isAtm: boolean;
  ce: {
    ltp: number;
    oi: number;
    oiChange: number;
    iv: number;
    delta: number;
    gamma: number;
    theta: number;
    vega?: number;
    volume: number;
    health?: { state: "explosive" | "healthy" | "weak" | "dead" | "unknown"; score: number };
  };
  pe: {
    ltp: number;
    oi: number;
    oiChange: number;
    iv: number;
    delta: number;
    gamma: number;
    theta: number;
    vega?: number;
    volume: number;
    health?: { state: "explosive" | "healthy" | "weak" | "dead" | "unknown"; score: number };
  };
}

export interface PremiumHealth {
  state: "explosive" | "healthy" | "weak" | "dead" | "unknown";
  score: number;
  ltp: number | null;
  factors: Record<string, number | string>;
}

export interface IntelSnapshot {
  ok: boolean;
  symbol: SymbolKey;
  displayName: string;
  at: number;
  error?: string;
  dataSource?: "live" | "closed-market-fallback";

  market: {
    isOpen: boolean;
    phase: string;
    aggressionFactor: number;
    isExpiryWindow: boolean;
  };

  spot: {
    ltp: number;
    change: number;
    changePct: number;
    dayHigh: number;
    dayLow: number;
    pdh: number;
    pdl: number;
    priorClose?: number;
    openingRangeHigh: number;
    openingRangeLow: number;
    vwap: number;
    ema9: number;
    ema20: number;
    ema50: number;
  };

  futures: {
    ltp: number;
    premium: number;
    basisState: string;
    basis: number;
    direction: Bias;
    leadLagScore: number;
    score: number;
    aggressive: boolean;
    available: boolean;
    reasoning: string;
  };

  regime: {
    market: string;
    volatility: string;
    meta: string;
    gamma: string;
    orderflow: string;
    aggressionMode: string;
    mtfStructure: string;
  };

  bias: {
    directionScore: number;
    overallBias: Bias;
    allowedDirections: Bias[];
    reasoning: string;
    smartMoney: string;
    smartMoneyStrength: number;
  };

  confidence: {
    bullish: number;
    bearish: number;
    winning: number;
    pillars: Record<string, { score: number; reasons?: string[] }> | null;
  };

  premiumHealth: { ce: PremiumHealth; pe: PremiumHealth };

  trap: {
    risk: "low" | "medium" | "high";
    score: number;
    blocked: boolean;
    hardBlock: boolean;
    reasoning: string;
    breakdown: Record<string, { score: number; reasons?: string[] }>;
  };

  flow: {
    delta: {
      cvd: number;
      velocity: number;
      velocityScore: number;
      velocityState: string;
      acceleration: number;
      flip: boolean;
      exhaustion: boolean;
      bias: Bias;
      strength: number;
      trend: string;
      divergence: string | null;
    };
    microstructure: {
      bidAskImbalance: number;
      absorption: boolean;
      absorptionSide: string | null;
      iceberg: boolean;
      spoofing: boolean;
      liquidityPull: boolean;
      score: number;
      available: boolean;
    };
    volume: {
      spike: boolean;
      ratio: number;
      state: string;
      vsa: string;
      vsaBias: Bias;
      poc: number;
      vah: number;
      val: number;
      hvns: Array<{ price: number; volume?: number }>;
      lvns: Array<{ price: number; volume?: number }>;
      acceptance: string;
      zone: string;
    };
    oi: {
      ceWriting: boolean;
      peWriting: boolean;
      ceUnwinding: boolean;
      peUnwinding: boolean;
      pcr: number;
      ceTotal: number;
      peTotal: number;
      velocity: number;
      acceleration: number;
      migration: unknown;
      absorption: boolean;
      qualityScore: number;
    };
  };

  options: {
    atm: number;
    maxPain: number;
    atmIv: number | null;
    atmCall: { symbol?: string; ltp: number; oi: number; iv: number; delta: number } | null;
    atmPut: { symbol?: string; ltp: number; oi: number; iv: number; delta: number } | null;
    callWall: number | null;
    putWall: number | null;
  };

  smc: {
    bos: unknown;
    choch: unknown;
    orderBlocks: unknown[];
    fvg: unknown[];
  };

  structure: {
    dayHigh: number;
    dayLow: number;
    pdh: number;
    pdl: number;
    priorClose?: number;
    orh: number;
    orl: number;
    swingHighs: Array<{ price: number; index: number }>;
    swingLows: Array<{ price: number; index: number }>;
    distances: Record<string, number | null> | null;
  };

  ladder: LadderRow[];

  cpr?: {
    pivot: number;
    tc: number;
    bc: number;
    r1: number;
    r2: number;
    r3: number;
    s1: number;
    s2: number;
    s3: number;
    width: number;
    widthPct: number;
    widthClass: "narrow" | "normal" | "wide";
  } | null;

  avwap?: {
    session: number | null;
    priorDay: number | null;
  };

  macro?: {
    vix?: { price: number; change: number; changePct: number; previousClose: number } | null;
    giftNifty?: { price: number; change: number; changePct: number; previousClose: number } | null;
    usFutures?: {
      sp500?: { price: number; changePct: number } | null;
      nasdaq?: { price: number; changePct: number } | null;
    };
    dxy?: { price: number; changePct: number } | null;
    crude?: { price: number; changePct: number } | null;
    nikkei?: { price: number; changePct: number } | null;
    fiiDii?: {
      date: string;
      cash: {
        fii: { buy_sell_difference: number; net_action: string };
        dii: { buy_sell_difference: number; net_action: string };
      };
    } | null;
  } | null;

  heavyweights?: {
    rows: Array<{
      symbol: string;
      name: string;
      weight: number;
      price?: number;
      change?: number;
      changePct?: number;
    }>;
    weightedAvgChangePct: number;
    leaders: Array<{ name: string; changePct: number }>;
    laggards: Array<{ name: string; changePct: number }>;
  } | null;

  verdict?: {
    side: "CE" | "PE" | "NEUTRAL";
    verdict: "STRONG_BULLISH" | "BULLISH" | "NEUTRAL" | "BEARISH" | "STRONG_BEARISH";
    cePct: number;
    pePct: number;
    factors: Record<string, number>;
    weights: Record<string, number>;
  };

  tradePlan?: {
    action: "BUY_CE" | "BUY_PE" | "NO_TRADE" | "WAIT";
    reason: string;
    pick: {
      side: "CE" | "PE";
      strike: number;
      ltp: number;
      delta: number;
      iv: number;
      oi: number;
      gamma: number;
      theta: number;
      health?: { state: string; score: number };
      moneyness: "ITM" | "ATM" | "OTM";
      sl: number;
      target: number;
      slPts: number;
      targetPts: number;
      rr: number;
    } | null;
  };

  action: {
    action: Action;
    reason: string;
  };

  debug: {
    payloadKeys: string[];
    innerKeys?: string[];
    candleCounts: Record<string, number>;
    strikeCount?: number;
    ladderCount?: number;
    tickDeltaActive: boolean;
    microstructureAvailable: boolean;
    futuresLeadAvailable: boolean;
    deltaAvailable: boolean;
    executionMode: string;
    activeEngines: Record<string, boolean>;
  };
}
