import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Shared color tokens — institutional black + neon
export const V3_TONE = {
  bull:    { color: "#22c55e", border: "rgba(34,197,94,0.30)",  soft: "rgba(34,197,94,0.06)" },
  bear:    { color: "#ef4444", border: "rgba(239,68,68,0.30)",  soft: "rgba(239,68,68,0.06)" },
  warn:    { color: "#facc15", border: "rgba(250,204,21,0.30)", soft: "rgba(250,204,21,0.06)" },
  neutral: { color: "#94a3b8", border: "rgba(148,163,184,0.20)", soft: "rgba(148,163,184,0.04)" },
  info:    { color: "#38bdf8", border: "rgba(56,189,248,0.30)", soft: "rgba(56,189,248,0.06)" },
} as const;

export type V3ToneKey = keyof typeof V3_TONE;

// ─── Card wrapper ─────────────────────────────────────────────────────
export function V3Card({
  title, icon, right, children, className, accent, glow,
}: {
  title?: ReactNode;
  icon?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  accent?: V3ToneKey;
  glow?: boolean;
}) {
  const t = accent ? V3_TONE[accent] : null;
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-md border bg-[#0a0d12]",
        glow && t && "shadow-[0_0_20px_-6px_var(--accent-glow,rgba(0,0,0,0.5))]",
        className,
      )}
      style={{
        borderColor: t?.border ?? "rgba(255,255,255,0.06)",
        ...(glow && t ? { ['--accent-glow' as string]: t.color + '88' } : {}),
      }}
    >
      {title ? (
        <div
          className="flex shrink-0 items-center justify-between border-b px-2 py-1"
          style={{ borderColor: t?.border ?? "rgba(255,255,255,0.05)" }}
        >
          <h3
            className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em]"
            style={{ color: t?.color ?? "rgba(255,255,255,0.85)" }}
          >
            {icon ? <span className="text-[12px] leading-none">{icon}</span> : null}
            {title}
          </h3>
          {right}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
        {children}
      </div>
    </div>
  );
}

// ─── Pill ─────────────────────────────────────────────────────────────
export function V3Pill({
  label, tone = "neutral", size = "sm", filled = false,
}: {
  label: ReactNode;
  tone?: V3ToneKey;
  size?: "xs" | "sm";
  filled?: boolean;
}) {
  const t = V3_TONE[tone];
  const padding = size === "xs" ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-0.5 text-[10px]";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm font-bold uppercase tracking-wider",
        padding,
      )}
      style={{
        background: filled ? t.color + "22" : t.soft,
        color: t.color,
        border: `1px solid ${t.border}`,
      }}
    >
      {label}
    </span>
  );
}

// ─── Number formatters ────────────────────────────────────────────────
export function v3Fmt(n: number | null | undefined, d = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: d, maximumFractionDigits: d,
  });
}
export function v3FmtSigned(n: number | null | undefined, d = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return sign + v3Fmt(n, d);
}
export function v3FmtPct(n: number | null | undefined, d = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(d)}%`;
}

// ─── Tiny stat tile ───────────────────────────────────────────────────
export function V3Stat({
  label, value, valueColor, sub,
}: {
  label: string;
  value: ReactNode;
  valueColor?: string;
  sub?: ReactNode;
}) {
  return (
    <div className="flex flex-col rounded-md border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5">
      <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-white/45">{label}</span>
      <span
        className="mt-0.5 font-mono text-[14px] font-bold tabular-nums"
        style={{ color: valueColor || "#e5e7eb" }}
      >
        {value}
      </span>
      {sub ? <span className="mt-0.5 text-[10px] text-white/55">{sub}</span> : null}
    </div>
  );
}

// ─── Strength bar (5-segment) ─────────────────────────────────────────
export function V3StrengthBar({ pct, color }: { pct: number; color: string }) {
  const segs = 5;
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * segs);
  return (
    <span className="flex items-center gap-[2px]">
      {Array.from({ length: segs }).map((_, i) => (
        <span
          key={i}
          className="block h-2 w-2.5 rounded-[1px]"
          style={{ background: i < filled ? color : "rgba(255,255,255,0.10)" }}
        />
      ))}
    </span>
  );
}
