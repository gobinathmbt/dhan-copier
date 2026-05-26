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
    volume: number;
  };
  pe: {
    ltp: number;
    oi: number;
    oiChange: number;
    iv: number;
    delta: number;
    gamma: number;
    theta: number;
    volume: number;
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
    orh: number;
    orl: number;
    swingHighs: Array<{ price: number; index: number }>;
    swingLows: Array<{ price: number; index: number }>;
    distances: Record<string, number | null> | null;
  };

  ladder: LadderRow[];

  chart: {
    candles1m: IntelSparkCandle[];
    candles5m: IntelSparkCandle[];
  };

  action: {
    action: Action;
    reason: string;
  };

  debug: {
    payloadKeys: string[];
    candleCounts: Record<string, number>;
    tickDeltaActive: boolean;
    microstructureAvailable: boolean;
    futuresLeadAvailable: boolean;
    deltaAvailable: boolean;
    executionMode: string;
    activeEngines: Record<string, boolean>;
  };
}
