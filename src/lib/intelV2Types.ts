// Types mirroring backend/src/services/intelV2.service.js → getSnapshot output.
// Self-contained, NOT shared with v1 intelTypes.ts.

export type IntelV2Symbol = "NIFTY_50" | "SENSEX" | "BANKNIFTY";

export type Tone = "bull" | "bear" | "warn" | "neutral" | "info" | "purple";

export interface StatusTile {
  label: string;
  tone: string;
  sub: string;
  key: string;
}

export interface ConfidenceTile {
  score: number;
  label: string;
  key: string;
}

export interface LadderLeg {
  ltp: number;
  oi: number;
  oiChange: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  volume: number;
  health: { state: "explosive" | "healthy" | "weak" | "dead" | "unknown"; score: number };
  buildup: string | null;
}

export interface LadderRow {
  strike: number;
  isAtm: boolean;
  ce: LadderLeg;
  pe: LadderLeg;
}

export interface OiHistogramRow {
  strike: number;
  isAtm: boolean;
  ceOiChg: number;
  peOiChg: number;
  ceOi: number;
  peOi: number;
}

export interface OptionChainRow {
  strike: number;
  isAtm: boolean;
  ce: { oi: number; oiChg: number; ltp: number; iv: number; delta: number };
  pe: { oi: number; oiChg: number; ltp: number; iv: number; delta: number };
}

export interface SupportResistanceRow {
  strike: number;
  oi: number;
  oiChange: number;
  distance: number;
  oiCompact: { val: number; unit: string };
  oiChangeCompact: { val: number; unit: string };
}

export interface TopStrike {
  strike: number;
  side: "CE" | "PE";
  label: string;
  type: "BUY" | "SELL" | "AVOID" | "WATCH";
  score: number;
  confidence: number;
  reason: string;
}

export interface KeyLevel {
  label: string;
  value: number;
  kind: "resistance" | "support" | "pivot";
}

export interface TrapRow {
  key: string;
  label: string;
  detected: boolean;
}

export interface NoTradeCondition {
  key: string;
  label: string;
  detected: boolean;
}

export interface IntelV2Snapshot {
  ok: boolean;
  version: "v2";
  symbol: IntelV2Symbol;
  displayName: string;
  requestedDate: string;
  date: string;
  isToday: boolean;
  fallbackUsed: boolean;
  at: number;
  dataSource: string;

  market: {
    isOpen: boolean;
    phase: string;
    reason?: string;
  };

  spot: {
    ltp: number;
    change: number;
    changePct: number;
    dayHigh: number;
    dayLow: number;
    priorClose: number;
    vwap: number | null;
    ema9: number | null;
    ema20: number | null;
    ema50: number | null;
    atr: number | null;
    rsi: number | null;
    sessionAvwap: number | null;
    priorAvwap: number | null;
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
    overallBias: "bullish" | "bearish" | "neutral";
    smartMoney: "buyers" | "sellers" | "neutral";
    reasoning: string;
  };

  confidence: { winning: number; label: string };

  trap: {
    risk: "low" | "medium" | "high";
    score: number;
    detected: number;
    rows: TrapRow[];
  };

  flow: {
    delta: {
      bias: "bullish" | "bearish" | "neutral";
      cvd: number;
      totalBuy: number;
      totalSell: number;
      deltaPct: number;
      netDelta: number;
    };
    volume: {
      poc: number;
      vah: number;
      val: number;
      hvns: Array<{ price: number; volume: number }>;
      lvns: Array<{ price: number; volume: number }>;
    } | null;
    oi: {
      ceWriting: boolean;
      peWriting: boolean;
      ceUnwinding: boolean;
      peUnwinding: boolean;
      pcr: number;
      ceTotal: number;
      peTotal: number;
    };
  };

  options: {
    atm: number | null;
    maxPain: number | null;
    atmIv: number;
    atmCall: { ltp: number; oi: number; iv: number; delta: number } | null;
    atmPut:  { ltp: number; oi: number; iv: number; delta: number } | null;
    callWall: number | null;
    putWall: number | null;
    expiry: string | null;
  };

  cpr: null | {
    pivot: number; tc: number; bc: number;
    r1: number; r2: number; r3: number;
    s1: number; s2: number; s3: number;
    width: number; widthPct: number;
    widthClass: "narrow" | "normal" | "wide";
  };

  avwap: { session: number | null; priorDay: number | null };

  macro: null | {
    vix?: { price: number; changePct: number } | null;
    giftNifty?: { price: number; changePct: number } | null;
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
  };

  heavyweights: null | {
    rows: Array<{
      symbol: string; name: string; weight: number;
      price?: number; changePct?: number;
    }>;
    weightedAvgChangePct: number;
    leaders: Array<{ name: string; changePct: number }>;
    laggards: Array<{ name: string; changePct: number }>;
  };

  verdict: {
    side: "CE" | "PE" | "NEUTRAL";
    verdict: "STRONG_BULLISH" | "BULLISH" | "NEUTRAL" | "BEARISH" | "STRONG_BEARISH";
    cePct: number; pePct: number;
    factors: Record<string, number>;
    weights: Record<string, number>;
  };

  tradePlan: {
    action: "BUY_CE" | "BUY_PE" | "NO_TRADE" | "WAIT";
    reason: string;
    pick: null | {
      side: "CE" | "PE"; strike: number; ltp: number; delta: number;
      iv: number; oi: number; gamma: number; theta: number;
      health: { state: string; score: number };
      moneyness: "ITM" | "ATM" | "OTM";
      sl: number; target: number; slPts: number; targetPts: number; rr: number;
    };
  };

  ladder: LadderRow[];

  tradingDay: {
    today: string;
    requestedDate: string;
    actualDate: string;
    fallbackUsed: boolean;
    expiry: string | null;
    expiryDate: string | null;
    daysToExpiry: number | null;
    lotSize: number;
  };

  dashboard: {
    statusWidgets: {
      marketState: StatusTile;
      smartMoney: StatusTile;
      futures: StatusTile;
      premium: StatusTile;
      delta: StatusTile;
      trapRisk: StatusTile;
      bestAction: StatusTile;
      confidence: ConfidenceTile;
      oiStructure: StatusTile;
      vwap: StatusTile;
    };
    tradingDay: IntelV2Snapshot["tradingDay"];
    spotFutSeries: {
      spot: Array<{ t: number; v: number }>;
      futures: Array<{ t: number; v: number }>;
    };
    buildUp: { longBuildUp: boolean; shortCovering: boolean; longUnwinding: boolean; shortBuildUp: boolean };
    futuresInfo: {
      oi: number; oiChange: number; volume: number;
      ltp: number; premium: number; basis: number; basisTrend: string;
    };
    oiHistogram: OiHistogramRow[];
    cvdSeries: Array<{ t: number; cvd: number; lastLtp: number | null }>;
    delta: {
      totalBuyVol: number; totalSellVol: number;
      netDelta: number; deltaPct: number; bidAskImbalance: number;
    };
    frvpHistogram: Array<{ price: number; volume: number }>;
    priceAbovePoc: number | null;
    breadth: {
      advancing: number; declining: number; unchanged: number;
      total?: number; sampled?: number;
      advancePct: number; declinePct?: number; adRatio: number;
      leaders?: Array<{ symbol: string; changePct: number; price?: number }>;
      laggards?: Array<{ symbol: string; changePct: number; price?: number }>;
      source?: string;
    };
    heavyweightsImpact: Array<{
      symbol: string; name: string; last: number;
      changePct: number; weight: number; impactPts: number;
    }>;
    heavyweightsTotalImpact: number;
    ivAnalytics: {
      vix: number | null;
      vixChangePct: number | null;
      atmIv: number;
      atmIvChangePct: number | null;
      ivRank: { score: number; label: string; tone: string };
      trend: Array<{ t: number; iv: number }>;
    };
    trapDetector: TrapRow[];
    regimeClassification: {
      dayType: string; tone: string;
      volatility: string; trendStrength: string;
      marketQuality: string; participation: string;
    };
    optionChainSnapshot: OptionChainRow[];
    topStrikeSelections: { ce: TopStrike[]; pe: TopStrike[]; all: TopStrike[] };
    supportResistance: {
      supports: SupportResistanceRow[];
      resistances: SupportResistanceRow[];
      pressureScore: number;
      verdict: "BULLISH" | "NEUTRAL" | "BEARISH";
      bias: "support" | "balanced" | "resistance";
      supportStrength: number;
      resistanceStrength: number;
      spotPrice: number;
      atmStrike: number;
      reasoning: string;
    };
    riskManagement: null | {
      entryPrice: number; stopLoss: number;
      target1: number; target2: number; rr: number;
      maxLossPerLot: number; maxLossTotal: number;
      positionLots: number; lotSize: number;
      slPts: number; targetPts: number;
      target1Pct: number; target2Pct: number; slPct: number;
    };
    keyLevels: KeyLevel[];
    noTradeConditions: {
      conditions: NoTradeCondition[];
      result: "SAFE TO TRADE" | "CAUTION" | "NO TRADE";
      resultTone: string;
      flagged: number;
    };
    liveAlerts: Array<{
      time: string; label: string; detail: string;
      value: string; tone: "bull" | "bear" | "warn" | "neutral";
    }>;
    spark1m: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>;
  };

  debug: {
    candleCounts: Record<string, number>;
    strikeCount: number;
    ladderCount: number;
    candleSource: string;
    optionChainSource: string;
  };
}
