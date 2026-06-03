/* ─────────────────────────────────────────────────────────────────────
 * Strike Chart response shape — primary CE/PE candle series + cross-leg
 * first-5-min HIGH marker levels.
 * ───────────────────────────────────────────────────────────────────── */

import type { StrikeSymbol } from "./strikeTableTypes";

export type { StrikeSymbol };

export interface ChartCandle {
  time: number;   // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PrimaryLeg {
  strike: number;
  securityId: string | number | null;
  candles: ChartCandle[];
  firstFiveHigh: number;
  firstFiveLow: number;
  ltp: number;
}

export interface ChartMarker {
  sourceStrike: number;
  sourceSide: "CE" | "PE";
  sourceOffset: number;
  price: number;
  label: string;
}

export interface StrikeChartResponse {
  ok: boolean;
  version: "strike-chart-v1";
  symbol: StrikeSymbol;
  displayName: string;
  date: string;
  isToday: boolean;
  at: number;
  spot: number;
  atm: number;
  step: number;
  offset: number;
  interval: "1" | "5" | "15" | "25" | "30";
  source: "live" | "folder";
  primary: {
    ce: PrimaryLeg;
    pe: PrimaryLeg;
  };
  markers: {
    ceChart: ChartMarker[];
    peChart: ChartMarker[];
  };
  error?: string;
}
