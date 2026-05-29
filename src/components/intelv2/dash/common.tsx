import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

// ── Tone palette (matches the dark institutional console) ────────────────
export const V2_TONE = {
  bull:    { color: "#22c55e", soft: "rgba(34,197,94,0.12)",  border: "rgba(34,197,94,0.35)" },
  bear:    { color: "#ef4444", soft: "rgba(239,68,68,0.12)",  border: "rgba(239,68,68,0.35)" },
  warn:    { color: "#f59e0b", soft: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.35)" },
  info:    { color: "#3b82f6", soft: "rgba(59,130,246,0.12)", border: "rgba(59,130,246,0.35)" },
  purple:  { color: "#a855f7", soft: "rgba(168,85,247,0.12)", border: "rgba(168,85,247,0.35)" },
  neutral: { color: "#9ca3af", soft: "rgba(156,163,175,0.10)", border: "rgba(156,163,175,0.25)" },
} as const;

export type V2ToneKey = keyof typeof V2_TONE;
export function v2Tone(key: string | undefined | null): V2ToneKey {
  if (!key) return "neutral";
  if (key in V2_TONE) return key as V2ToneKey;
  return "neutral";
}

// ── Number formatters ────────────────────────────────────────────────────
export function v2Fmt(n: number | null | undefined, d = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function v2FmtSigned(n: number | null | undefined, d = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}
export function v2FmtCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)} K`;
  return `${n.toFixed(0)}`;
}
export function v2FmtSignedCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${sign}${(n / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}${(n / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${sign}${(n / 1e3).toFixed(1)} K`;
  return `${sign}${n.toFixed(0)}`;
}

// ── Generic card wrapper ─────────────────────────────────────────────────
export function V2Card({
  title, right, children, className, pad = true, accent,
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  pad?: boolean;
  accent?: V2ToneKey;
}) {
  const t = accent ? V2_TONE[accent] : null;
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-white/[0.07] bg-[#0e1117] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.02)]",
        className,
      )}
      style={t ? { borderColor: t.border } : undefined}
    >
      {title ? (
        <div className="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-4 py-2">
          <h3 className="text-[12px] font-bold uppercase tracking-[0.18em] text-white/75">
            {title}
          </h3>
          {right}
        </div>
      ) : null}
      <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", pad && "p-3.5")}>
        {children}
      </div>
    </div>
  );
}

// ── Numbered-row label (matches the "1 / 2 / 3 / 4 / 5" left rail) ──────
export function V2RowLabel({ n, label }: { n: number; label: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center rounded-md border border-white/[0.06] bg-[#0a0d12] px-1 py-2">
      <span className="text-3xl font-black tracking-tight text-white/85">{n}</span>
      <span className="mt-1 max-w-[80px] text-center text-[10px] font-semibold uppercase leading-tight tracking-[0.14em] text-white/55">
        {label}
      </span>
    </div>
  );
}

// ── Pill / badge ─────────────────────────────────────────────────────────
export function V2Pill({
  label, tone = "neutral", size = "sm",
}: {
  label: ReactNode;
  tone?: V2ToneKey;
  size?: "xs" | "sm" | "md";
}) {
  const t = V2_TONE[tone];
  const sizing =
    size === "xs" ? "px-1.5 py-0.5 text-[10px]" :
    size === "md" ? "px-2.5 py-1 text-[12px]"  :
                    "px-2 py-0.5 text-[11px]";
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-sm font-bold uppercase",
        sizing,
      )}
      style={{ background: t.soft, color: t.color, letterSpacing: "0.04em" }}
    >
      {label}
    </span>
  );
}

// ── Yes/No dot ───────────────────────────────────────────────────────────
export function V2Dot({ yes, label }: { yes: boolean; label?: string }) {
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

// ── Mini row stat (label/value/hint) ────────────────────────────────────
export function V2Stat({
  label, value, hint, tone = "neutral", align = "left",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: V2ToneKey;
  align?: "left" | "right";
}) {
  return (
    <div className={cn("flex flex-col gap-0.5", align === "right" && "items-end")}>
      <span className="text-[10px] uppercase tracking-[0.12em] text-white/45">{label}</span>
      <span className="font-mono text-[15px] font-bold tabular-nums" style={{ color: V2_TONE[tone].color }}>
        {value}
      </span>
      {hint ? <span className="text-[10px] text-white/45">{hint}</span> : null}
    </div>
  );
}

// ── Card hint footer (the "Interpretation: ..." bar each card carries) ──
export function V2Hint({
  label = "Interpretation",
  text,
  tone = "info",
}: {
  label?: string;
  text: ReactNode;
  tone?: V2ToneKey;
}) {
  if (!text) return null;
  const t = V2_TONE[tone];
  return (
    <div
      className="mt-auto flex items-start gap-1.5 rounded-sm border border-white/[0.05] px-2.5 py-1.5"
      style={{ background: t.soft }}
    >
      <span
        className="shrink-0 text-[9px] font-bold uppercase tracking-[0.14em]"
        style={{ color: t.color }}
      >
        {label}:
      </span>
      <span className="text-[11px] leading-tight text-white/85">{text}</span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * V2MiniPie — tiny donut chart for cards.
 *  • value: percentage 0..100 of the dominant slice
 *  • tone:  fill colour (uses V2_TONE palette)
 *  • size:  px diameter (default 56)
 *  • label: optional text rendered in the center
 *  • showPct: whether to render the percentage in the center (default true)
 *
 * Renders a clean SVG donut — no chart library dep, just two arcs.
 * Use anywhere: Delta, Breadth, Heavyweights, IV, VWAP, EMA, CPR, Max Pain.
 * ───────────────────────────────────────────────────────────────────── */
export function V2MiniPie({
  value,
  tone = "info",
  size = 56,
  label,
  showPct = true,
  trackTone = "neutral",
}: {
  value: number;
  tone?: V2ToneKey;
  size?: number;
  label?: string;
  showPct?: boolean;
  trackTone?: V2ToneKey;
}) {
  const v = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const r = 36;
  const c = 2 * Math.PI * r;
  const arc = (v / 100) * c;
  // Slimmer ring — gives inner text more breathing room.
  // Was 0.18; now 0.10 (e.g. 110px pie → 11px stroke instead of 20px).
  const stroke = Math.max(5, size * 0.10);
  const fillColor = V2_TONE[tone].color;
  const trackColor = V2_TONE[trackTone].soft;
  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
        <circle cx="50" cy="50" r={r} fill="none" stroke={trackColor} strokeWidth={stroke} />
        <circle
          cx="50" cy="50" r={r}
          fill="none"
          stroke={fillColor}
          strokeWidth={stroke}
          strokeDasharray={`${arc} ${c}`}
          strokeLinecap="butt"
        />
      </svg>
      {(showPct || label) ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {showPct ? (
            <span
              className="font-mono font-black leading-none tabular-nums"
              style={{ color: fillColor, fontSize: size * 0.20 }}
            >
              {Math.round(v)}%
            </span>
          ) : null}
          {label ? (
            <span
              className="mt-0.5 font-bold uppercase tracking-wider"
              style={{ color: fillColor, fontSize: Math.max(7, size * 0.09) }}
            >
              {label}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
