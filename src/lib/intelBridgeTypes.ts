/* ─────────────────────────────────────────────────────────────────────
 * INTEL BRIDGE — Institutional Intent Converter (V2 → V6) response shape
 * ───────────────────────────────────────────────────────────────────── */

export type BridgeSymbol = "NIFTY_50" | "SENSEX" | "BANKNIFTY";
export type BridgeSide = "BULL" | "BEAR" | "NEUTRAL";

export interface BridgeDriver {
  label: string;
  side: "BULL" | "BEAR";
  pts?: number;
  active?: boolean;
}

export interface BridgeFlowStage {
  stage: string;
  source: "V2" | "BRIDGE" | "V6";
  value: string;
  tone: string;
}

export interface BridgeDecision {
  ok: boolean;
  version: "bridge";
  symbol: BridgeSymbol;
  displayName: string;
  date: string;
  isToday: boolean;
  at: number;

  header: { spot: number; change: number; changePct: number; vix: number };

  marketReadiness: {
    score: number;
    status: "EXCELLENT" | "GOOD" | "FAIR" | "POOR";
    tone: string;
    ok: boolean;
    sections: Array<{
      key: string;
      score: number;
      max: number;
      items: Array<{ ok: boolean; pts: number; label: string }>;
    }>;
    interpretation: string;
  };

  conviction: {
    side: BridgeSide;
    value: number;
    bull: number;
    bear: number;
    tier: string;
    tone: string;
  };

  premium: {
    probability: number;
    expectedBehavior: string;
    tone: string;
    pexScore: number;
    pexState: string;
    gammaRegime: string;
    gammaPremium: string;
    greeksAgree: boolean;
    strikeAgree: boolean;
    gammaExpansion: boolean;
  };

  drivers: BridgeDriver[];
  allDrivers: BridgeDriver[];

  verdict: {
    action: string;
    label: string;
    tone: string;
    rationale: string;
    v6Gate: string;
    v6Setup: string;
  };

  flowStages: BridgeFlowStage[];

  sources: {
    v2: {
      oiShiftSide: string;
      oiShiftBullPct: number;
      marketView: string | null;
      pcr: number;
      deltaPct: number;
      breadthPct: number;
      futPremium: number;
    };
    v6: {
      setup: string;
      netScore: number;
      alignment: string | null;
      grade: string | null;
      greeksSide: string;
      strikeMomentum: string;
      auctionZone: string;
      buyerQuality: number;
    };
  };

  goldenRule: string;
}
