import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

// ── Tone helpers ──────────────────────────────────────────────────────────
export const TONE = {
  bull: { color: "#22c55e", soft: "rgba(34,197,94,0.12)", border: "rgba(34,197,94,0.35)" },
  bear: { color: "#ef4444", soft: "rgba(239,68,68,0.12)", border: "rgba(239,68,68,0.35)" },
  warn: { color: "#f59e0b", soft: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.35)" },
  info: { color: "#3b82f6", soft: "rgba(59,130,246,0.12)", border: "rgba(59,130,246,0.35)" },
  purple: { color: "#a855f7", soft: "rgba(168,85,247,0.12)", border: "rgba(168,85,247,0.35)" },
  neutral: { color: "#9ca3af", soft: "rgba(156,163,175,0.12)", border: "rgba(156,163,175,0.25)" },
} as const;

export type ToneKey = keyof typeof TONE;

export function toneOf(key: string | undefined | null): ToneKey {
  if (!key) return "neutral";
  if (key in TONE) return key as ToneKey;
  return "neutral";
}

// ── Compact number formatters ────────────────────────────────────────────
export function fmt(n: number | null | undefined, d = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

export function fmtCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)} K`;
  return `${n.toFixed(0)}`;
}

export function fmtSigned(n: number | null | undefined, d = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

export function fmtSignedCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${sign}${(n / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}${(n / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${sign}${(n / 1e3).toFixed(1)} K`;
  return `${sign}${n.toFixed(0)}`;
}

// ── Card wrapper ─────────────────────────────────────────────────────────
export function Card({
  title,
  right,
  children,
  className,
  pad = true,
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  pad?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-white/[0.07] bg-[#11141a] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.02)]",
        className,
      )}
    >
      {title ? (
        <div className="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-3 py-1.5">
          <h3 className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/65">
            {title}
          </h3>
          {right}
        </div>
      ) : null}
      <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", pad && "p-2.5")}>{children}</div>
    </div>
  );
}

// ── Pill / chip ──────────────────────────────────────────────────────────
export function Pill({
  label,
  tone = "neutral",
  size = "sm",
}: {
  label: ReactNode;
  tone?: ToneKey;
  size?: "xs" | "sm";
}) {
  const t = TONE[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-sm font-bold uppercase",
        size === "xs" ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-0.5 text-[10px]",
      )}
      style={{ background: t.soft, color: t.color, letterSpacing: "0.04em" }}
    >
      {label}
    </span>
  );
}

// ── Tiny dot indicator (✓/✗) ─────────────────────────────────────────────
export function YesNoDot({ yes, label }: { yes: boolean; label?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold",
        yes ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400",
      )}
      title={label}
    >
      {yes ? "✓" : "✗"}
    </span>
  );
}

// ── Stat with label/value/colored value ──────────────────────────────────
export function Stat({
  label,
  value,
  hint,
  tone = "neutral",
  align = "left",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: ToneKey;
  align?: "left" | "right";
}) {
  return (
    <div className={cn("flex flex-col gap-0.5", align === "right" && "items-end")}>
      <span className="text-[9px] uppercase tracking-[0.12em] text-white/40">{label}</span>
      <span className="font-mono text-sm font-bold tabular-nums" style={{ color: TONE[tone].color }}>
        {value}
      </span>
      {hint ? <span className="text-[10px] text-white/45">{hint}</span> : null}
    </div>
  );
}
