import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Settings, Play, Square, Brain,
  TrendingUp, TrendingDown, ScrollText, Wifi, WifiOff,
  Zap, BarChart2, X,
} from "lucide-react";
import { isAuthenticated } from "@/lib/auth";
import { api, apiErrorMessage } from "@/lib/api";
import { getDhanBypassKey } from "@/lib/dhanBypass";
import DataTableLayout from "@/components/common/DataTableLayout";
import { AlgoSettingsDialog, loadConfig, type AlgoConfig } from "@/components/scalping/AlgoSettingsDialog";
import { EngineLogsDialog } from "@/components/scalping/EngineLogsDialog";
import { Badge } from "@/components/ui/badge";
import { TableHead, TableRow, TableCell } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { useScalpingSocket } from "@/hooks/useScalpingSocket";

export const Route = createFileRoute("/scalping")({
  component: ScalpingPage,
});

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScalpingTrade {
  _id: string;
  signal: "BUY_CE" | "BUY_PE";
  strike: number;
  optionSymbol?: string;
  entryPrice: number;
  currentPrice: number;
  exitPrice?: number;
  sl?: number;
  target?: number;
  quantity: number;
  lotSize: number;
  aiConfidence?: number;
  marketRegime?: string;
  buildUpType?: string;
  vwapState?: string;
  oiDirection?: string;
  // Trade type
  tradeType?: "SCALP" | "SWING";
  // Engine routing (NEW 2026-05-19)
  engineType?: "ULTRA_SCALP" | "SUPPORT_SCALP" | "CORE";
  market?: string;
  // Brokerage
  brokerageEnabled?: boolean;
  grossPnL?: number;
  brokerageCharges?: number;
  status: "open" | "closed" | "rejected";
  result?: "WIN" | "LOSS" | "BREAKEVEN" | null;
  pnl: number;
  pnlPct: number;
  openedAt: string;
  closedAt?: string;
  entryReason?: string;
  exitReason?: string;
}

interface ScalpingSession {
  _id: string;
  status: string;
  initialCapital: number;
  currentCapital: number;
  realizedPnL: number;
  totalBrokerageCharges: number;
  totalTrades: number;
  wins: number;
  losses: number;
  cycleCount: number;
  lastCycleAt?: string;
  lastError?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number, digits = 2) {
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function TradeTypeBadge({ type }: { type?: "SCALP" | "SWING" }) {
  if (type === "SWING") {
    return (
      <Badge
        variant="outline"
        className="text-violet-600 border-violet-500/40 bg-violet-500/5 gap-1 text-[10px] font-semibold"
      >
        <BarChart2 className="h-2.5 w-2.5" />
        SWING
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-amber-500 border-amber-500/40 bg-amber-500/5 gap-1 text-[10px] font-semibold"
    >
      <Zap className="h-2.5 w-2.5" />
      SCALP
    </Badge>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function ScalpingPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(20);
  const [paginationEnabled, setPaginationEnabled] = useState(true);

  useEffect(() => {
    if (!isAuthenticated()) navigate({ to: "/login" });
  }, [navigate]);

  const statusQuery = useQuery({
    queryKey: ["scalping-status"],
    queryFn: async () => (await api.get("/api/scalping/status")).data,
    refetchInterval: false,
    enabled: isAuthenticated(),
  });

  const tradesQuery = useQuery({
    queryKey: ["scalping-trades", statusQuery.data?.session?._id],
    queryFn: async () => {
      const sid = statusQuery.data?.session?._id;
      const res = await api.get("/api/scalping/trades", {
        params: sid ? { sessionId: sid } : {},
      });
      return res.data.trades as ScalpingTrade[];
    },
    refetchInterval: false,
    enabled: isAuthenticated() && !!statusQuery.data,
  });

  // ── WebSocket ──────────────────────────────────────────────────────────────
  const { connected } = useScalpingSocket({
    sessionId: statusQuery.data?.session?._id,
    enabled: isAuthenticated(),
    onTradeUpdate: (data) => {
      if (data.type === "trade_created") {
        const type = data.trade.tradeType ?? "SCALP";
        const icon = type === "SWING" ? "📈" : "⚡";
        toast.success(
          `${icon} New ${type} trade: ${data.trade.signal} @ ${data.trade.strike}`
        );
      } else if (data.type === "trade_closed") {
        const { result, pnl, grossPnL, brokerageCharges, tradeType } = data.trade;
        const type = tradeType ?? "SCALP";
        const icon = type === "SWING" ? "📈" : "⚡";
        const gross = grossPnL ?? pnl ?? 0;
        const brok  = brokerageCharges ?? 0;
        const net   = gross - brok;
        if (result === "WIN") {
          toast.success(
            `✅ ${icon} ${type} WIN  gross ₹${fmt(gross)}  net ₹${fmt(net)}`
          );
        } else if (result === "LOSS") {
          toast.error(
            `❌ ${icon} ${type} LOSS  gross ₹${fmt(gross)}  net ₹${fmt(net)}`
          );
        } else {
          toast.info(`${icon} ${type} trade closed: ${result ?? "BREAKEVEN"}`);
        }
      } else if (data.type === "trade_updated" && data.updateType === "quantity") {
        toast.info("📈 Added lot to winning position");
      }
    },
    onEngineEvent: (data) => {
      if (data.type === "engine_started") toast.success("🚀 Engine started");
      else if (data.type === "engine_stopped")
        toast.info(`Engine stopped: ${data.reason}`);
    },
  });

  // ── Mutations ──────────────────────────────────────────────────────────────
  const startMut = useMutation({
    mutationFn: async () => {
      const authKey = getDhanBypassKey();
      // Auth key is optional - backend will use production token if not provided
      const headers = authKey ? { "X-Dhan-Bypass-Key": authKey } : {};
      
      // Backend now manages settings - no need to send from frontend
      // Settings are loaded from backend/src/config/algoSettings.js
      const res = await api.post(
        "/api/scalping/start",
        {}, // Empty body - backend uses its own settings
        { headers }
      );
      return res.data;
    },
    onSuccess: () => {
      toast.success("Prediction engine started with backend settings");
      qc.invalidateQueries({ queryKey: ["scalping-status"] });
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  const stopMut = useMutation({
    mutationFn: async () => (await api.post("/api/scalping/stop")).data,
    onSuccess: () => {
      toast.success("Engine stopped");
      qc.invalidateQueries({ queryKey: ["scalping-status"] });
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  const exitTradeMut = useMutation({
    mutationFn: async (tradeId: string) => 
      (await api.post(`/api/scalping/trades/${tradeId}/exit`)).data,
    onSuccess: () => {
      toast.success("Trade manually exited");
      qc.invalidateQueries({ queryKey: ["scalping-trades"] });
      qc.invalidateQueries({ queryKey: ["scalping-status"] });
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  const handleStart = async () => {
    // Backend now manages settings - no need to load from frontend
    try {
      const ms = (await api.get("/api/scalping/market-status")).data;
      if (!ms.open) {
        toast.error(`Market is not live. ${ms.reason || ""} — try later.`);
        return;
      }
    } catch {
      toast.error("Could not verify market status");
      return;
    }
    startMut.mutate(); // No config needed - backend uses its own settings
  };

  // ── Derived state ──────────────────────────────────────────────────────────
  const session: ScalpingSession | undefined = statusQuery.data?.session;
  const running = !!statusQuery.data?.running;
  const trades = tradesQuery.data || [];

  const openTrades   = trades.filter((t) => t.status === "open");
  const closedTrades = trades.filter((t) => t.status === "closed");

  const scalpTrades = closedTrades.filter((t) => (t.tradeType ?? "SCALP") === "SCALP");
  const swingTrades = closedTrades.filter((t) => t.tradeType === "SWING");

  const winRate = closedTrades.length
    ? Math.round(
        (closedTrades.filter((t) => t.result === "WIN").length /
          closedTrades.length) *
          100
      )
    : 0;

  const grossPnL      = session?.realizedPnL ?? 0;
  const totalBrokerage = session?.totalBrokerageCharges ?? 0;
  const netPnL        = grossPnL - totalBrokerage;

  // ── Stat chips ─────────────────────────────────────────────────────────────
  const statChips = [
    {
      label: "Status",
      value: running ? "RUNNING" : "IDLE",
      bgColor: running ? "bg-emerald-500/10" : "bg-muted",
      textColor: running ? "text-emerald-600" : "text-foreground",
    },
    {
      label: "WebSocket",
      value: connected ? "CONNECTED" : "DISCONNECTED",
      bgColor: connected ? "bg-emerald-500/10" : "bg-destructive/10",
      textColor: connected ? "text-emerald-600" : "text-destructive",
      icon: connected ? (
        <Wifi className="h-3 w-3" />
      ) : (
        <WifiOff className="h-3 w-3" />
      ),
    },
    {
      label: "Capital",
      value: `₹${(session?.currentCapital ?? 0).toLocaleString("en-IN")}`,
    },
    {
      label: "P&L",
      value: (
        <span className="flex items-center gap-1.5">
          <span className={grossPnL >= 0 ? "text-emerald-600" : "text-destructive"}>
            ₹{fmt(grossPnL)}
          </span>
          {totalBrokerage > 0 && (
            <span
              className={`text-[11px] font-normal px-1.5 py-0.5 rounded-sm ${
                netPnL >= 0
                  ? "bg-emerald-500/10 text-emerald-600"
                  : "bg-destructive/10 text-destructive"
              }`}
            >
              net ₹{fmt(netPnL)}
            </span>
          )}
        </span>
      ),
      textColor: grossPnL >= 0 ? "text-emerald-600" : "text-destructive",
    },
    { label: "Trades", value: `${session?.totalTrades ?? 0}` },
    { label: "Win Rate", value: `${winRate}%` },
    {
      label: "⚡ Scalp",
      value: `${scalpTrades.length}`,
      textColor: "text-amber-500",
    },
    {
      label: "📈 Swing",
      value: `${swingTrades.length}`,
      textColor: "text-violet-600",
    },
    { label: "Open", value: `${openTrades.length}` },
    { label: "Cycles", value: `${session?.cycleCount ?? 0}` },
  ];

  // ── Action buttons ─────────────────────────────────────────────────────────
  const actionButtons = [
    {
      icon: <Settings className="h-4 w-4" />,
      tooltip: "Algo Settings",
      onClick: () => setSettingsOpen(true),
      variant: "outline" as const,
    },
    {
      icon: <ScrollText className="h-4 w-4" />,
      tooltip: "View Engine Logs",
      onClick: () => setLogsOpen(true),
      variant: "outline" as const,
      disabled: !session,
    },
    running
      ? {
          icon: <Square className="h-4 w-4" />,
          tooltip: "Stop Engine",
          onClick: () => stopMut.mutate(),
          variant: "outline" as const,
          className: "text-destructive border-destructive/30",
          disabled: stopMut.isPending,
        }
      : {
          icon: <Play className="h-4 w-4" />,
          tooltip: "Start Predicting",
          onClick: handleStart,
          variant: "default" as const,
          className: "bg-primary text-primary-foreground",
          disabled: startMut.isPending,
        },
  ];

  const pageTrades = paginationEnabled
    ? trades.slice((page - 1) * rowsPerPage, page * rowsPerPage)
    : trades;

  // ── Table ──────────────────────────────────────────────────────────────────
  const COL_COUNT = 23; // keep in sync with renderHeader (added Actions column)

  const renderHeader = () => (
    <TableRow>
      <TableHead>Time</TableHead>
      <TableHead>Duration</TableHead>
      <TableHead>Engine</TableHead>
      <TableHead>Market</TableHead>
      <TableHead>Type</TableHead>
      <TableHead>Signal</TableHead>
      <TableHead>Strike</TableHead>
      <TableHead className="text-right">Entry ₹</TableHead>
      <TableHead className="text-right">Exit ₹</TableHead>
      <TableHead className="text-right">Points</TableHead>
      <TableHead>Lots</TableHead>
      <TableHead className="text-right">Qty</TableHead>
      <TableHead className="text-right">SL</TableHead>
      <TableHead className="text-right">Target</TableHead>
      <TableHead>Conf</TableHead>
      <TableHead>Regime</TableHead>
      <TableHead>Build-Up</TableHead>
      <TableHead>VWAP</TableHead>
      <TableHead>OI</TableHead>
      <TableHead>Status</TableHead>
      <TableHead className="text-right">P&L ₹</TableHead>
      <TableHead className="text-right">P&L %</TableHead>
      <TableHead>Result</TableHead>
      <TableHead>Exit Reason</TableHead>
      <TableHead className="text-center">Actions</TableHead>
    </TableRow>
  );

  const renderBody = () => (
    <>
      {pageTrades.map((t) => {
        const isCe = t.signal === "BUY_CE";

        // Duration
        const openTime   = new Date(t.openedAt).getTime();
        const closeTime  = t.closedAt ? new Date(t.closedAt).getTime() : Date.now();
        const durationMs = closeTime - openTime;
        const dMin       = Math.floor(durationMs / 60000);
        const dSec       = Math.floor((durationMs % 60000) / 1000);
        const durationStr = dMin > 0 ? `${dMin}m ${dSec}s` : `${dSec}s`;

        // Lots
        const lotSize  = t.lotSize || 65;
        const rawQty   = t.quantity || 65;
        const lots     = Math.max(1, Math.round(rawQty / lotSize));

        // Points
        const exitPrice  = t.exitPrice ?? t.currentPrice;
        const pointsDiff = exitPrice - t.entryPrice;
        const pointsColor =
          pointsDiff > 0
            ? "text-emerald-600"
            : pointsDiff < 0
            ? "text-destructive"
            : "";

        // P&L — use stored values; fall back gracefully
        const grossPnl = t.grossPnL ?? t.pnl ?? 0;
        // Always use the actual stored brokerageCharges (never hardcode ₹40)
        const brokerage = t.brokerageCharges ?? 0;
        const netPnl    = grossPnl - brokerage;
        const pnlColor  =
          grossPnl > 0
            ? "text-emerald-600"
            : grossPnl < 0
            ? "text-destructive"
            : "";

        return (
          <TableRow key={t._id}>
            {/* Time */}
            <TableCell className="text-xs whitespace-nowrap">
              {new Date(t.openedAt).toLocaleTimeString()}
            </TableCell>

            {/* Duration */}
            <TableCell className="text-xs whitespace-nowrap">
              <Badge variant="outline" className="font-mono text-[10px]">
                {durationStr}
              </Badge>
            </TableCell>

            {/* Engine */}
            <TableCell>
              <Badge
                variant="outline"
                className={`font-mono text-[10px] ${
                  t.engineType === "ULTRA_SCALP" ? "border-purple-400 text-purple-700" :
                  t.engineType === "SUPPORT_SCALP" ? "border-cyan-400 text-cyan-700" :
                  "border-slate-400 text-slate-700"
                }`}
              >
                {t.engineType
                  ? t.engineType.replace("_SCALP", "").replace("ULTRA", "ULTRA").replace("SUPPORT", "SUPPORT").replace("CORE", "CORE")
                  : "—"}
              </Badge>
            </TableCell>

            {/* Market */}
            <TableCell>
              <Badge variant="secondary" className="font-mono text-[10px]">
                {t.market || "NIFTY"}
              </Badge>
            </TableCell>

            {/* Trade Type */}
            <TableCell>
              <TradeTypeBadge type={t.tradeType} />
            </TableCell>

            {/* Signal */}
            <TableCell>
              <Badge
                variant="outline"
                className={
                  isCe
                    ? "text-emerald-600 border-emerald-600/40"
                    : "text-destructive border-destructive/40"
                }
              >
                {isCe ? (
                  <TrendingUp className="h-3 w-3 mr-1" />
                ) : (
                  <TrendingDown className="h-3 w-3 mr-1" />
                )}
                {t.signal.replace("BUY_", "")}
              </Badge>
            </TableCell>

            {/* Strike */}
            <TableCell className="font-medium">{t.strike}</TableCell>

            {/* Entry */}
            <TableCell className="text-right tabular-nums font-medium">
              ₹{t.entryPrice?.toFixed(2)}
            </TableCell>

            {/* Exit */}
            <TableCell className="text-right tabular-nums font-medium">
              {t.exitPrice
                ? `₹${t.exitPrice.toFixed(2)}`
                : `₹${t.currentPrice?.toFixed(2)}`}
            </TableCell>

            {/* Points */}
            <TableCell
              className={`text-right tabular-nums font-bold ${pointsColor}`}
            >
              {pointsDiff > 0 ? "+" : ""}
              {pointsDiff.toFixed(2)}
            </TableCell>

            {/* Lots */}
            <TableCell className="text-right tabular-nums">
              <Badge variant="secondary">{lots}</Badge>
            </TableCell>

            {/* Qty */}
            <TableCell className="text-right tabular-nums text-xs">
              {rawQty}
            </TableCell>

            {/* SL */}
            <TableCell className="text-right tabular-nums text-xs text-destructive">
              ₹{t.sl?.toFixed(2) || "-"}
            </TableCell>

            {/* Target */}
            <TableCell className="text-right tabular-nums text-xs text-emerald-600">
              ₹{t.target?.toFixed(2) || "-"}
            </TableCell>

            {/* Confidence */}
            <TableCell>
              <Badge variant="outline">{t.aiConfidence?.toFixed(1) ?? "-"}</Badge>
            </TableCell>

            {/* Regime */}
            <TableCell className="text-xs">{t.marketRegime || "-"}</TableCell>

            {/* Build-Up */}
            <TableCell className="text-xs">{t.buildUpType || "-"}</TableCell>

            {/* VWAP */}
            <TableCell className="text-xs">{t.vwapState || "-"}</TableCell>

            {/* OI */}
            <TableCell className="text-xs">{t.oiDirection || "-"}</TableCell>

            {/* Status */}
            <TableCell>
              <Badge variant={t.status === "open" ? "default" : "outline"}>
                {t.status}
              </Badge>
            </TableCell>

            {/* P&L ₹ */}
            <TableCell
              className={`text-right tabular-nums font-bold ${pnlColor}`}
            >
              {t.status === "closed" ? (
                <div className="flex flex-col items-end gap-0.5">
                  {/* Gross P&L */}
                  <span>₹{fmt(grossPnl)}</span>
                  {/* Net P&L after brokerage — only show if brokerage is stored */}
                  {brokerage > 0 && (
                    <span
                      className={`text-[10px] font-normal px-1 py-0.5 rounded-sm ${
                        netPnl >= 0
                          ? "bg-emerald-500/10 text-emerald-600"
                          : "bg-destructive/10 text-destructive"
                      }`}
                    >
                      net ₹{fmt(netPnl)}
                    </span>
                  )}
                  {/* Brokerage line */}
                  {brokerage > 0 && (
                    <span className="text-[9px] text-muted-foreground">
                      brok ₹{fmt(brokerage)}
                    </span>
                  )}
                </div>
              ) : (
                "-"
              )}
            </TableCell>

            {/* P&L % */}
            <TableCell
              className={`text-right tabular-nums font-semibold ${pnlColor}`}
            >
              {t.pnlPct
                ? `${t.pnlPct > 0 ? "+" : ""}${t.pnlPct.toFixed(2)}%`
                : "-"}
            </TableCell>

            {/* Result */}
            <TableCell>
              {t.result ? (
                <Badge
                  variant="outline"
                  className={
                    t.result === "WIN"
                      ? "text-emerald-600 border-emerald-600/40"
                      : t.result === "LOSS"
                      ? "text-destructive border-destructive/40"
                      : ""
                  }
                >
                  {t.result}
                </Badge>
              ) : (
                "-"
              )}
            </TableCell>

            {/* Exit Reason */}
            <TableCell
              className="text-xs max-w-[200px] truncate"
              title={t.exitReason}
            >
              {t.exitReason || "-"}
            </TableCell>

            {/* Actions */}
            <TableCell className="text-center">
              {t.status === "open" && (
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    if (confirm(`Exit trade ${t.signal} @ ${t.strike}?`)) {
                      exitTradeMut.mutate(t._id);
                    }
                  }}
                  disabled={exitTradeMut.isPending}
                >
                  <X className="h-3 w-3 mr-1" />
                  Exit
                </Button>
              )}
            </TableCell>
          </TableRow>
        );
      })}

      {!pageTrades.length && (
        <TableRow>
          <TableCell
            colSpan={COL_COUNT}
            className="text-center py-12 text-muted-foreground"
          >
            <Brain className="h-8 w-8 mx-auto mb-2 opacity-50" />
            {running
              ? "Engine running — waiting for first AI signal..."
              : "No trades yet. Click Start Predicting to begin."}
          </TableCell>
        </TableRow>
      )}
    </>
  );

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      <DataTableLayout
        title="Intraday Scalping Algo AI"
        isLoading={tradesQuery.isLoading}
        totalCount={trades.length}
        statChips={statChips}
        actionButtons={actionButtons}
        page={page}
        rowsPerPage={rowsPerPage}
        paginationEnabled={paginationEnabled}
        onPageChange={setPage}
        onRowsPerPageChange={(r) => setRowsPerPage(Number(r))}
        onPaginationToggle={setPaginationEnabled}
        renderTableHeader={renderHeader}
        renderTableBody={renderBody}
        onRefresh={() => {
          qc.invalidateQueries({ queryKey: ["scalping-status"] });
          qc.invalidateQueries({ queryKey: ["scalping-trades"] });
        }}
        cookieName="scalping_pagination"
        skeletonColumns={COL_COUNT}
      />

      <AlgoSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onSave={() => toast.success("Settings saved")}
      />

      <EngineLogsDialog
        open={logsOpen}
        onOpenChange={setLogsOpen}
        sessionId={session?._id || null}
      />
    </>
  );
}
