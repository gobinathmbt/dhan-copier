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
  ceLtp?: number;
  peLtp?: number;
  ceDelta?: number;
  peDelta?: number;
  ceBuyScore?: number;
  peBuyScore?: number;
  ceFavorPct?: number;
  peFavorPct?: number;
  favorSide?: "CE" | "PE" | "NEUTRAL";
  favorPct?: number;
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
    live?: boolean;
    liveTickAgeMs?: number | null;
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
    buildUp: {
      longBuildUp: boolean;
      shortCovering: boolean;
      longUnwinding: boolean;
      shortBuildUp: boolean;
      longBuildUpStrike:   { strike: number; side: "PE"; delta: number } | null;
      shortBuildUpStrike:  { strike: number; side: "CE"; delta: number } | null;
      longUnwindingStrike: { strike: number; side: "PE"; delta: number } | null;
      shortCoveringStrike: { strike: number; side: "CE"; delta: number } | null;
      strengthLabel: "STRONG" | "MODERATE" | "WEAK";
      velocityLabel: "HIGH" | "MODERATE" | "LOW";
      shiftBias: string;
      interpretation: string;
    };
    buyerSellerFlow: {
      ce: { net: number; label: string; buyersPct: number; sellersPct: number; buyersAbs: number };
      pe: { net: number; label: string; buyersPct: number; sellersPct: number; buyersAbs: number };
    };
    auctionIntensity: {
      score: number;
      label: string;
      tone: string;
      hint: string;
    };
    vwapAvwapIntraday: {
      vwap: number | null;
      avwapDay: number | null;
      priceVsVwap: string;
      bias: string;
    };
    frvpAuction: null | {
      poc: number; vah: number; val: number;
      sessionHigh: number; sessionLow: number;
      ibHigh: number | null; ibLow: number | null;
      insideValueRange: string;
      valueAreaPct: number;
      totalVolume: number;
      volumeIB: number;
      volumeOOR: number;
      pocType: string;
      auctionBias: string;
      initiative: string;
      acceptedAboveVAH: string;
      rejectedBelowVAL: string;
      bins: Array<{ price: number; volume: number }>;
      summary: { label: string; tone: string; sub: string; score: number };
    };
    frvpInstitutional: {
      vah: number | null;
      poc: number | null;
      val: number | null;
      price: number;
      insideValue: "YES" | "NO";
      outsideValue: "YES" | "NO";
      markerPct: number;
      buyers:  { entering: number; leaving: number };
      sellers: { entering: number; leaving: number };
      participationStrike: number | null;
      participationLevel: "High" | "Medium" | "Low";
      interpretation: string;
      engine: null | {
        profile: {
          vah: number; val: number; poc: number;
          totalVolume: number;
          profileStrength: number;
          hvnZones: Array<{ price: number; volume: number; share: number }>;
          lvnZones: Array<{ price: number; volume: number; share: number }>;
          bins: Array<{ price: number; volume: number }>;
          step: number;
        };
        location: {
          insideValue: boolean;
          outsideValue: boolean;
          nearPOC: boolean;
          markerPct: number;
          side: "above_value" | "below_value" | "inside_value" | "unknown";
        };
        acceptance: {
          acceptedAboveVAH: boolean;
          acceptedBelowVAL: boolean;
          rejectedAboveVAH: boolean;
          rejectedBelowVAL: boolean;
          consecutiveAbove: number;
          consecutiveBelow: number;
          volumeSurgeAbove: boolean;
          volumeSurgeBelow: boolean;
          lastClose: number | null;
        };
        selectedStrikes: Array<{
          strike: number; isAtm: boolean;
          ceOi: number; peOi: number;
          ceVol: number; peVol: number;
          ceOiChg: number; peOiChg: number;
          ceLtp: number; peLtp: number;
          ceIv: number; peIv: number;
          ceBuildup: string; peBuildup: string;
        }>;
        flow: {
          ceBuy: number; ceSell: number;
          peBuy: number; peSell: number;
          ceBuyersPct: number; peBuyersPct: number;
          ceSellersPct: number; peSellersPct: number;
          buyersEntering: number; sellersEntering: number;
          selectedCount: number;
          dominantCeBuyStrike: number | null;
          dominantCeSellStrike: number | null;
          dominantPeBuyStrike: number | null;
          dominantPeSellStrike: number | null;
          perStrike: Array<{
            strike: number;
            ceTag: string; peTag: string;
            ceBuyShare: number; ceSellShare: number;
            peBuyShare: number; peSellShare: number;
          }>;
        };
        delta: {
          cumulative: number;
          deltaPct: number;
          totalVolume?: number;
          bias: "bullish" | "bearish" | "neutral";
        };
        dominance: {
          buyersScore: number;
          sellersScore: number;
          dominantSide: "BUYERS" | "SELLERS" | "BALANCED";
          pctFavour: number;
          conviction: "high" | "normal" | "divergent";
        };
        interpretation: {
          verdict: string;
          tone: string;
          lines: string[];
          summary: string;
        };
        advanced: {
          developingPOC: Array<{ t: number; poc: number }>;
          gammaWall: { strike: number; gex: number } | null;
          premiumVel: { ceLtp: number; peLtp: number; total: number; skew: number; state: string } | null;
          nakedPOC: { price: number; volume: number; share: number } | null;
          trapped: { side: string; detail: string } | null;
        };
        directionalBias: {
          side: "CE" | "PE" | "NEUTRAL";
          strength: "STRONG" | "MODERATE" | "WEAK";
          reason: string;
          targetStrike: number | null;
        };
        tone: string;
      };
    };
    futuresInfo: {
      oi: number; oiChange: number; volume: number;
      ltp: number; premium: number; basis: number; basisTrend: string;
      interpretation?: string;
    };
    oiHistogram: OiHistogramRow[];
    oiShiftBias: {
      bullishPct: number;
      bearishPct: number;
      side: "CALL" | "PUT" | "BALANCED";
      pctFavour: number;
      label: string;
      trend: {
        direction: "BULLISH" | "BEARISH" | "NEUTRAL";
        strength: "STRONG" | "MODERATE" | "MILD" | "WEAK";
        momentum: number;
        dominantSide: string | null;
        dominantStrike: number | null;
        dominantBuild: string | null;
        dominantValue: number;
        callBuildCount: number;
        putBuildCount: number;
        label: string;
      };
    };
    oiBuildupAnalysis: null | {
      spot: { price: number };
      totals: {
        ce: { today: number; prev: number; change: number; changePct: number };
        pe: { today: number; prev: number; change: number; changePct: number };
        pcr: number;
      };
      marketView: { label: string; tone: string; ratio: number };
      ceTable: Array<{
        strike: number;
        oiToday: number;
        oiPrev: number;
        oiChange: number;
        oiChangePct: number;
        interpretation: string;
        isAtm: boolean;
      }>;
      peTable: Array<{
        strike: number;
        oiToday: number;
        oiPrev: number;
        oiChange: number;
        oiChangePct: number;
        interpretation: string;
        isAtm: boolean;
      }>;
      ceChart: Array<{ strike: number; oiChange: number; isAtm: boolean }>;
      peChart: Array<{ strike: number; oiChange: number; isAtm: boolean }>;
      ceTakeaway: string;
      peTakeaway: string;
    };
    cvdSeries: Array<{ t: number; cvd: number; lastLtp: number | null }>;
    delta: {
      totalBuyVol: number; totalSellVol: number;
      netDelta: number; deltaPct: number; bidAskImbalance: number;
      interpretation?: string;
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
      interpretation?: string;
    };
    heavyweightsImpact: Array<{
      symbol: string; name: string; last: number;
      changePct: number; weight: number; impactPts: number;
    }>;
    heavyweightsTotalImpact: number;
    heavyweightsAlignment?: { aligned: number; total: number; score: string; label: string };
    ivAnalytics: {
      vix: number | null;
      vixChangePct: number | null;
      atmIv: number;
      atmIvChangePct: number | null;
      ivRank: { score: number; label: string; tone: string };
      trend: Array<{ t: number; iv: number }>;
      interpretation?: string;
    };
    trapDetector: TrapRow[];
    regimeClassification: {
      dayType: string; tone: string;
      volatility: string; trendStrength: string;
      marketQuality: string; participation: string;
    };
    optionChainSnapshot: OptionChainRow[];
    topStrikeSelections: { ce: TopStrike[]; pe: TopStrike[]; all: TopStrike[] };
    bestTradePick: null | {
      ce: null | {
        side: "CE";
        strike: number;
        ltp: number;
        oi: number;
        delta: number;
        iv: number;
        health: { state: string; score: number };
        moneyness: string;
        probability: number;
        action: "STRONG BUY" | "BUY" | "CAUTIOUS BUY" | "WAIT" | "AVOID";
        label: string;
        reasoning: string;
        factors: Record<string, number>;
      };
      pe: null | {
        side: "PE";
        strike: number;
        ltp: number;
        oi: number;
        delta: number;
        iv: number;
        health: { state: string; score: number };
        moneyness: string;
        probability: number;
        action: "STRONG BUY" | "BUY" | "CAUTIOUS BUY" | "WAIT" | "AVOID";
        label: string;
        reasoning: string;
        factors: Record<string, number>;
      };
      primary: "CE" | "PE" | "NEUTRAL";
      spread: number;
    };
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
    hints?: Record<string, string>;
  };

  debug: {
    candleCounts: Record<string, number>;
    strikeCount: number;
    ladderCount: number;
    candleSource: string;
    optionChainSource: string;
  };
}
