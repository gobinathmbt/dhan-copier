// Centralised institutional palette so every widget uses the same colours.

export const INTEL_COLORS = {
  bull: "#10b981",
  bullSoft: "rgba(16, 185, 129, 0.15)",
  bullBorder: "rgba(16, 185, 129, 0.45)",
  bear: "#ef4444",
  bearSoft: "rgba(239, 68, 68, 0.15)",
  bearBorder: "rgba(239, 68, 68, 0.45)",
  warn: "#f59e0b",
  warnSoft: "rgba(245, 158, 11, 0.15)",
  warnBorder: "rgba(245, 158, 11, 0.45)",
  liquidity: "#3b82f6",
  liquiditySoft: "rgba(59, 130, 246, 0.15)",
  liquidityBorder: "rgba(59, 130, 246, 0.45)",
  gamma: "#a855f7",
  gammaSoft: "rgba(168, 85, 247, 0.15)",
  gammaBorder: "rgba(168, 85, 247, 0.45)",
  neutral: "#6b7280",
  neutralSoft: "rgba(107, 114, 128, 0.15)",
  neutralBorder: "rgba(107, 114, 128, 0.45)",
  bg: "#0a0a0b",
  panel: "#111114",
  panelSoft: "#16161a",
  border: "rgba(255,255,255,0.08)",
  borderStrong: "rgba(255,255,255,0.16)",
  text: "#e5e7eb",
  textMuted: "#9ca3af",
  textDim: "#6b7280",
};

export function biasColor(bias: string | undefined | null): string {
  if (bias === "bullish") return INTEL_COLORS.bull;
  if (bias === "bearish") return INTEL_COLORS.bear;
  return INTEL_COLORS.neutral;
}

export function biasBg(bias: string | undefined | null): string {
  if (bias === "bullish") return INTEL_COLORS.bullSoft;
  if (bias === "bearish") return INTEL_COLORS.bearSoft;
  return INTEL_COLORS.neutralSoft;
}

export function trapColor(risk: string | undefined | null): string {
  if (risk === "high") return INTEL_COLORS.bear;
  if (risk === "medium") return INTEL_COLORS.warn;
  return INTEL_COLORS.bull;
}

export function premiumStateColor(state: string | undefined | null): string {
  if (state === "explosive") return INTEL_COLORS.bull;
  if (state === "healthy") return "#22c55e";
  if (state === "weak") return INTEL_COLORS.warn;
  if (state === "dead") return INTEL_COLORS.bear;
  return INTEL_COLORS.neutral;
}

export function regimeColor(regime: string | undefined | null): string {
  if (!regime) return INTEL_COLORS.neutral;
  if (regime.includes("bullish") || regime.includes("trending_bull")) return INTEL_COLORS.bull;
  if (regime.includes("bearish") || regime.includes("trending_bear")) return INTEL_COLORS.bear;
  if (regime.includes("gamma") || regime.includes("pin")) return INTEL_COLORS.gamma;
  if (regime.includes("balanced") || regime.includes("ranging")) return INTEL_COLORS.warn;
  if (regime.includes("expansion")) return INTEL_COLORS.liquidity;
  if (regime.includes("trap")) return INTEL_COLORS.warn;
  return INTEL_COLORS.neutral;
}

export function actionColor(action: string | undefined | null): string {
  if (action === "BUY_CE") return INTEL_COLORS.bull;
  if (action === "BUY_PE") return INTEL_COLORS.bear;
  if (action === "WAIT") return INTEL_COLORS.warn;
  return INTEL_COLORS.neutral;
}
