import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { getDhanBypassKey } from "@/lib/dhanBypass";

// ============================================================
// SETTINGS NOW MANAGED IN BACKEND
// ============================================================
// All algo settings are now centralized in:
// backend/src/config/algoSettings.js
//
// This component now fetches settings from backend and displays them
// as read-only. To modify settings, edit the backend file.
// ============================================================

export interface ScalpingSettings {
  capital: number;
  maxCapitalUsagePct: number;
  riskPerTradePct: number;
  maxDailyLossPct: number;
  minConfidence: number;
  minBreakoutProb: number;
  minTrendStrength: number;
  minRR: number;
  targetPoints: number;
  slPoints: number;
  maxHoldTimeSeconds: number;
  enableSwing: boolean;
  swingMinPoints: number;
  swingMaxHoldMinutes: number;
  lotSize: number;
  minLots: number;
  maxLots: number;
  maxConcurrentTrades: number;
  cooldownSec: number;
  enableTrailingSL: boolean;
  enableDynamicExit: boolean;
  enableAIRevalidation: boolean;
  enableBrokerageCalculation: boolean;
  enableFuturesConfirmation: boolean;
  ultraScalping: boolean;
  useMasterSignalWhenNeutral: boolean;
  masterMinScore: number;
  masterMinConfidence: number;
  masterMinAgreement: number;
  minDirectionSpread: number;
  ensembleMinVotes: number;
  strategyMode: string;
  executionMode: "simulation" | "live";
  // Hybrid engine settings
  useHybridEngine: boolean;
  hybridMinScore: number;
  hybridMinGrade: string;
  executionMinScore: number;
  maxTradesPerDay: number;
  maxLossesPerDay: number;
  trapBlockThreshold: number;
  enableHybridAIAdvisory: boolean;
  filters: {
    vwap: boolean; oi: boolean; regime: boolean; liquiditySweep: boolean;
    volumeSpike: boolean; bankNifty: boolean; volatility: boolean;
    gamma: boolean; maxPain: boolean; buildUp: boolean;
  };
}

export interface AlgoConfig {
  aiModel: string;
  settings: ScalpingSettings;
}

// Load config from backend
export async function loadConfig(): Promise<AlgoConfig> {
  try {
    const authKey = getDhanBypassKey();
    const headers: Record<string, string> = {};
    if (authKey) headers["x-dhan-bypass-key"] = authKey;
    
    const res = await api.get("/api/scalping/settings", { headers });
    if (res.data.ok) {
      return {
        aiModel: res.data.aiModel,
        settings: res.data.settings,
      };
    }
  } catch (err) {
    console.error("Failed to load settings from backend:", err);
    toast.error("Failed to load settings from backend");
  }
  
  // Fallback to default if backend fails
  return {
    aiModel: "gpt-4o-mini",
    settings: {} as ScalpingSettings,
  };
}

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSave: (cfg: AlgoConfig) => void;
}

export function AlgoSettingsDialog({ open, onOpenChange }: Props) {
  const [cfg, setCfg] = useState<AlgoConfig | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setLoading(true);
      loadConfig()
        .then((config) => setCfg(config))
        .finally(() => setLoading(false));
    }
  }, [open]);

  const handleClose = () => {
    onOpenChange(false);
  };

  if (loading || !cfg) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>⚡ Algo Settings</DialogTitle>
          </DialogHeader>
          <div className="flex items-center justify-center py-8">
            <div className="text-muted-foreground">Loading settings from backend...</div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  const s = cfg.settings;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            ⚡ Algo Settings (Read-Only)
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            Settings are now managed in <code className="bg-muted px-1 py-0.5 rounded">backend/src/config/algoSettings.js</code>
          </p>
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">
            To modify settings, edit the backend file and restart the server. This allows Kiro to easily optimize settings based on logs.
          </p>
        </DialogHeader>

        <div className="space-y-4 mt-4">
          {/* Display current settings in a readable format */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <h3 className="font-semibold text-sm">Capital Management</h3>
              <div className="text-xs space-y-1 bg-muted p-3 rounded">
                <div>Capital: ₹{s.capital?.toLocaleString()}</div>
                <div>Max Capital Usage: {s.maxCapitalUsagePct}%</div>
                <div>Risk Per Trade: {s.riskPerTradePct}%</div>
                <div>Max Daily Loss: {s.maxDailyLossPct}%</div>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="font-semibold text-sm">Scalping Settings</h3>
              <div className="text-xs space-y-1 bg-muted p-3 rounded">
                <div>Target Points: {s.targetPoints}</div>
                <div>SL Points: {s.slPoints}</div>
                <div>Max Hold Time: {s.maxHoldTimeSeconds}s</div>
                <div>Cooldown: {s.cooldownSec}s</div>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="font-semibold text-sm">Lot Management</h3>
              <div className="text-xs space-y-1 bg-muted p-3 rounded">
                <div>Lot Size: {s.lotSize}</div>
                <div>Min Lots: {s.minLots}</div>
                <div>Max Lots: {s.maxLots}</div>
                <div>Max Concurrent: {s.maxConcurrentTrades}</div>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="font-semibold text-sm">AI Configuration</h3>
              <div className="text-xs space-y-1 bg-muted p-3 rounded">
                <div>Model: {cfg.aiModel}</div>
                <div>Min Confidence: {s.minConfidence}</div>
                <div>Min Breakout Prob: {s.minBreakoutProb}</div>
                <div>Min Trend Strength: {s.minTrendStrength}</div>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="font-semibold text-sm">Swing Settings</h3>
              <div className="text-xs space-y-1 bg-muted p-3 rounded">
                <div>Enable Swing: {s.enableSwing ? '✓' : '✗'}</div>
                <div>Swing Min Points: {s.swingMinPoints}</div>
                <div>Swing Max Hold: {s.swingMaxHoldMinutes}m</div>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="font-semibold text-sm">Master Algorithm</h3>
              <div className="text-xs space-y-1 bg-muted p-3 rounded">
                <div>Min Score: {s.masterMinScore}</div>
                <div>Min Confidence: {s.masterMinConfidence}</div>
                <div>Min Agreement: {s.masterMinAgreement}</div>
                <div>Min Direction Spread: {s.minDirectionSpread}</div>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="font-semibold text-sm">Hybrid Engine</h3>
              <div className="text-xs space-y-1 bg-muted p-3 rounded">
                <div>Enabled: {s.useHybridEngine ? '✓' : '✗'}</div>
                <div>Min Score: {s.hybridMinScore}</div>
                <div>Min Grade: {s.hybridMinGrade}</div>
                <div>Execution Min Score: {s.executionMinScore}</div>
                <div>Max Trades/Day: {s.maxTradesPerDay}</div>
                <div>Max Losses/Day: {s.maxLossesPerDay}</div>
                <div>Trap Block Threshold: {s.trapBlockThreshold}</div>
                <div>AI Advisory: {s.enableHybridAIAdvisory ? '✓' : '✗'}</div>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="font-semibold text-sm">Active Filters</h3>
            <div className="flex flex-wrap gap-2">
              {Object.entries(s.filters || {}).map(([key, value]) => (
                value && (
                  <span key={key} className="text-xs bg-green-500/10 text-green-600 dark:text-green-400 px-2 py-1 rounded">
                    {key}
                  </span>
                )
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="font-semibold text-sm">Feature Toggles</h3>
            <div className="flex flex-wrap gap-2 text-xs">
              {s.enableTrailingSL && <span className="bg-blue-500/10 text-blue-600 px-2 py-1 rounded">Trailing SL</span>}
              {s.enableDynamicExit && <span className="bg-blue-500/10 text-blue-600 px-2 py-1 rounded">Dynamic Exit</span>}
              {s.enableAIRevalidation && <span className="bg-blue-500/10 text-blue-600 px-2 py-1 rounded">AI Revalidation</span>}
              {s.enableBrokerageCalculation && <span className="bg-blue-500/10 text-blue-600 px-2 py-1 rounded">Brokerage Calc</span>}
              {s.enableFuturesConfirmation && <span className="bg-blue-500/10 text-blue-600 px-2 py-1 rounded">Futures Confirm</span>}
              {s.ultraScalping && <span className="bg-violet-500/10 text-violet-600 px-2 py-1 rounded">Ultra Scalping</span>}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={handleClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
