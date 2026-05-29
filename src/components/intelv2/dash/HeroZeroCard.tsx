import type { IntelV2Snapshot } from "@/lib/intelV2Types";
import { V2_TONE } from "./common";

/**
 * HERO OR ZERO — sniper banner
 * ========================================================================
 * Renders one of three states:
 *   🚀 HERO CE   — neon green, expanding CE setup
 *   🚀 HERO PE   — neon red,   expanding PE setup
 *   💀 ZERO TRADE — gray/yellow, no edge / trap / inside-value
 *
 * Backend lives at `data.dashboard.heroZero` and emits the verdict, target
 * strike, confidence, momentum tag, premium %, and top firing reasons.
 */
export function HeroZeroCard({ data }: { data: IntelV2Snapshot | null }) {
  const hz = data?.dashboard?.heroZero;
  if (!hz) {
    return (
      <div className="flex h-full items-center justify-center rounded-md border border-white/[0.08] bg-[#0e1117] px-3 py-2 text-[12px] text-white/40">
        Hero/Zero engine warming up…
      </div>
    );
  }

  const isHero = hz.verdict === "HERO_CE" || hz.verdict === "HERO_PE";
  const isCE = hz.verdict === "HERO_CE";
  const isPE = hz.verdict === "HERO_PE";

  // Color system per spec
  const accent = isCE ? "#22c55e" : isPE ? "#ef4444" : "#facc15";
  const accentSoft = isCE ? "rgba(34,197,94,0.10)"
    : isPE ? "rgba(239,68,68,0.10)" : "rgba(250,204,21,0.10)";
  const accentBorder = isCE ? "rgba(34,197,94,0.50)"
    : isPE ? "rgba(239,68,68,0.50)" : "rgba(250,204,21,0.40)";
  const glow = isHero ? `0 0 32px ${accent}40, inset 0 0 18px ${accent}15` : "none";

  const emoji = isHero ? "🚀" : "💀";
  const verdictText = isCE ? "HERO CE"
    : isPE ? "HERO PE"
    : "ZERO TRADE";

  const ceScore = hz.scores.ce;
  const peScore = hz.scores.pe;
  const threshold = hz.scores.threshold;

  return (
    <div
      className="relative flex h-full min-h-0 flex-col gap-2 overflow-hidden rounded-lg border px-4 py-2.5"
      style={{
        borderColor: accentBorder,
        background: `linear-gradient(135deg, ${accentSoft} 0%, transparent 60%)`,
        boxShadow: glow,
      }}
    >
      {/* Pulse ring for HERO state */}
      {isHero ? (
        <span
          className="pointer-events-none absolute inset-0 animate-pulse rounded-lg"
          style={{ boxShadow: `inset 0 0 0 1px ${accent}55` }}
        />
      ) : null}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`text-[18px] ${isHero ? "animate-bounce" : ""}`} style={{ display: "inline-block" }}>
            {emoji}
          </span>
          <span
            className="text-[11px] font-bold uppercase tracking-[0.20em]"
            style={{ color: accent }}
          >
            HERO OR ZERO
          </span>
        </div>
        {/* Score chips */}
        <div className="flex items-center gap-1.5 text-[12px]">
          <span
            className="rounded-sm px-2 py-1 font-mono font-bold"
            style={{
              background: ceScore >= threshold ? "rgba(34,197,94,0.20)" : "rgba(255,255,255,0.05)",
              color: ceScore >= threshold ? "#22c55e" : "rgba(255,255,255,0.65)",
            }}
          >
            CE {ceScore}/9
          </span>
          <span
            className="rounded-sm px-2 py-1 font-mono font-bold"
            style={{
              background: peScore >= threshold ? "rgba(239,68,68,0.20)" : "rgba(255,255,255,0.05)",
              color: peScore >= threshold ? "#ef4444" : "rgba(255,255,255,0.65)",
            }}
          >
            PE {peScore}/9
          </span>
        </div>
      </div>

      {/* MAIN VERDICT */}
      <div className="flex flex-1 items-center justify-between gap-3">
        <div className="flex flex-col">
          <span
            className="text-[36px] font-black leading-none tracking-[0.04em]"
            style={{ color: accent, textShadow: isHero ? `0 0 12px ${accent}` : "none" }}
          >
            {verdictText}
          </span>
          {hz.strike != null ? (
            <span className="mt-1 font-mono text-[18px] font-bold" style={{ color: accent }}>
              {hz.strike.toLocaleString()} {hz.side}
              {hz.ltp ? <span className="ml-2 text-[12px] text-white/65">@ ₹{hz.ltp.toFixed(2)}</span> : null}
            </span>
          ) : (
            <span className="mt-1 text-[12px] font-bold uppercase tracking-wider text-white/55">
              Avoid Entry
            </span>
          )}
          <span className="mt-1 text-[11px] font-semibold" style={{ color: accent, opacity: 0.85 }}>
            {hz.headline}
          </span>
          <span className="text-[10px] text-white/65">{hz.subline}</span>
        </div>

        {/* Right-side stat cluster */}
        <div className="flex flex-col items-end gap-1">
          {hz.confidence != null ? (
            <div
              className="rounded-md border px-3 py-1.5 text-center"
              style={{ borderColor: accentBorder, background: accentSoft }}
            >
              <div className="text-[8px] font-bold uppercase tracking-[0.16em] text-white/55">Confidence</div>
              <div className="font-mono text-[24px] font-black leading-none" style={{ color: accent }}>
                {hz.confidence}%
              </div>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-1 text-[9px]">
            <Tile label="Momentum" value={hz.momentum} accent={accent} />
            <Tile label="Premium" value={hz.premiumPct} accent={accent} />
          </div>
        </div>
      </div>

      {/* Reasons strip */}
      {hz.reasons.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          {hz.reasons.map((r, i) => (
            <span
              key={i}
              className="rounded-sm px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
              style={{
                background: isHero ? `${accent}20` : "rgba(255,255,255,0.04)",
                color: isHero ? accent : "rgba(255,255,255,0.55)",
                border: `1px solid ${isHero ? accentBorder : "rgba(255,255,255,0.08)"}`,
              }}
            >
              {r}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div
      className="flex flex-col rounded-md border px-2.5 py-1.5"
      style={{ borderColor: accent + "44", background: accent + "08" }}
    >
      <span className="text-[10px] font-bold uppercase tracking-wider text-white/65">{label}</span>
      <span className="font-mono text-[14px] font-bold leading-tight" style={{ color: accent }}>
        {value}
      </span>
    </div>
  );
}

// Mark V2_TONE as used to keep tree-shaking parity if other files import this
export const _unused_V2_TONE = V2_TONE;
