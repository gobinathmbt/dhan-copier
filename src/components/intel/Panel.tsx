import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PanelProps {
  title?: ReactNode;
  badge?: ReactNode;
  className?: string;
  children: ReactNode;
  scroll?: boolean;
  dense?: boolean;
}

export function Panel({ title, badge, className, children, scroll, dense }: PanelProps) {
  return (
    <div
      className={cn(
        "relative flex flex-col rounded-lg border border-white/[0.08] bg-[#111114]/80 backdrop-blur-sm",
        "shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_8px_24px_-12px_rgba(0,0,0,0.6)]",
        className,
      )}
    >
      {title ? (
        <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/60">
            {title}
          </h3>
          {badge}
        </div>
      ) : null}
      <div className={cn(scroll && "overflow-auto", dense ? "p-2" : "p-3", "flex-1")}>
        {children}
      </div>
    </div>
  );
}

export function StatRow({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: ReactNode;
  tone?: "bull" | "bear" | "warn" | "neutral" | "info";
  hint?: string;
}) {
  const toneClass =
    tone === "bull"
      ? "text-emerald-400"
      : tone === "bear"
        ? "text-rose-400"
        : tone === "warn"
          ? "text-amber-400"
          : tone === "info"
            ? "text-sky-400"
            : "text-white/90";

  return (
    <div className="flex items-center justify-between gap-2 py-1 text-xs">
      <span className="text-white/50" title={hint}>
        {label}
      </span>
      <span className={cn("font-mono tabular-nums", toneClass)}>{value}</span>
    </div>
  );
}
