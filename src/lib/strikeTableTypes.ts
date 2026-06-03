/* ─────────────────────────────────────────────────────────────────────
 * Strike Table response shape — ATM ± N rows with first-5-min H/L per leg
 * ───────────────────────────────────────────────────────────────────── */

export type StrikeSymbol = "NIFTY_50" | "SENSEX" | "BANKNIFTY";

export interface StrikeLegData {
  ltp: number;
  oi: number;
  volume: number;
  firstFiveOpen: number | null;
  firstFiveHigh: number | null;
  firstFiveLow: number | null;
}

export interface StrikeRow {
  strike: number;
  offset: number;
  isAtm: boolean;
  ce: StrikeLegData;
  pe: StrikeLegData;
}

export interface StrikeTableResponse {
  ok: boolean;
  version: "strike-table-v1";
  symbol: StrikeSymbol;
  displayName: string;
  date: string;
  isToday: boolean;
  at: number;
  spot: number;
  spotChange: number;
  spotChangePct: number;
  atm: number;
  step: number;
  range: number;
  rowCount: number;
  source: "live" | "folder";
  fiveMin: {
    windowStartMs: number | null;
    windowEndMs: number | null;
    snapshotCount: number;
    ready: boolean;
    anchor?: "session-open" | "first-sample" | "none";
    sources?: { file: number; buffer: number };
  };
  chainSource?: string;
  rows: StrikeRow[];
  error?: string;
}
