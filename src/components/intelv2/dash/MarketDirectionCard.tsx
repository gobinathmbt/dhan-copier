import type { IntelV2Snapshot } from "@/lib/intelV2Types";
import { V2Card, V2_TONE } from "./common";

/**
 * 2.2 — MARKET DIRECTION CARD
 * ========================================================================
 * Three sections in one card (matches the institutional screenshot):
 *
 *   1. Market Direction Meter — split bar with Downside % / Upside % +
 *      a needle showing the bias position
 *   2. Intraday Levels (Important) — 3 resistances (Immediate / Strong /
 *      Extreme) and 3 supports (Immediate / Major / Critical)
 *   3. OI Estimated Move — Downside Target / Upside Target / Max Pain
 */
export function MarketDirectionCard({ data }: { data: IntelV2Snapshot | null }) {
  const md = data?.dashboard?.marketDirection;
  if (!md) {
    return (
      <V2Card title="2.2 Market Direction">
        <div className="flex h-full items-center justify-center text-[12px] text-white/45">
          Awaiting data…
        </div>
      </V2Card>
    );
  }
  const m = md.directionMeter;
  const move = md.oiEstimatedMove;
  const verdictColor = V2_TONE[m.tone].color;

  return (
    <V2Card title="2.2 Market Direction">
      <div className="-m-1.5 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-1.5 pr-2">
        {/* ──────────────────────────────────────────────────────────
            1. MARKET DIRECTION METER
        ────────────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-sky-300">
            Market Direction Meter
          </span>

          {/* Split bar with needle */}
          <div className="relative h-3 w-full overflow-visible rounded-full">
            {/* Background gradient — red→green */}
            <div
              className="absolute inset-0 rounded-full"
              style={{
                background:
                  "linear-gradient(to right, rgba(239,68,68,0.85) 0%, rgba(239,68,68,0.55) 30%, rgba(250,204,21,0.55) 50%, rgba(34,197,94,0.55) 70%, rgba(34,197,94,0.85) 100%)",
              }}
            />
            {/* Needle */}
            <div
              className="absolute -top-1 -translate-x-1/2"
              style={{ left: `${m.needlePos}%` }}
            >
              <div className="h-5 w-2.5 rounded-sm border-2 border-white bg-white shadow-[0_0_6px_rgba(255,255,255,0.6)]" />
            </div>
          </div>

          {/* Left/right pct chips */}
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-md border border-rose-500/40 bg-rose-500/[0.10] px-3 py-1.5">
              <div className="font-mono text-[22px] font-black leading-none text-rose-400">
                {m.downside}%
              </div>
              <div className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.16em] text-rose-400">
                Downside
              </div>
            </div>
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/[0.10] px-3 py-1.5 text-right">
              <div className="font-mono text-[22px] font-black leading-none text-emerald-400">
                {m.upside}%
              </div>
              <div className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-400">
                Upside
              </div>
            </div>
          </div>

          {/* Verdict pill */}
          <div className="flex items-center justify-center">
            <span
              className="rounded-sm px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.16em]"
              style={{ background: verdictColor + "22", color: verdictColor }}
            >
              {m.verdict}
            </span>
          </div>
        </div>

        {/* ──────────────────────────────────────────────────────────
            2. INTRADAY LEVELS (IMPORTANT)
        ────────────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/85">
            Intraday Levels <span className="text-white/45">(Important)</span>
          </span>

          {/* Resistances */}
          <div className="rounded-md border border-rose-500/30 bg-rose-500/[0.05]">
            {md.resistances.length === 0 && (
              <div className="px-2 py-2 text-center text-[10px] text-white/45">No resistance data</div>
            )}
            {md.resistances.map((r, i) => (
              <LevelRow key={i} label={r.tier} value={r.strike} tone="bear" first={i === 0} />
            ))}
          </div>

          {/* Supports */}
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.05]">
            {md.supports.length === 0 && (
              <div className="px-2 py-2 text-center text-[10px] text-white/45">No support data</div>
            )}
            {md.supports.map((r, i) => (
              <LevelRow key={i} label={r.tier} value={r.strike} tone="bull" first={i === 0} />
            ))}
          </div>
        </div>

        {/* ──────────────────────────────────────────────────────────
            3. OI ESTIMATED MOVE
        ────────────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-sky-300">
            OI Estimated Move
          </span>
          <div className="grid grid-cols-2 gap-2">
            <TargetTile
              label="Downside Target"
              value={move.downsideTarget}
              tone="bear"
              icon="▼"
            />
            <TargetTile
              label="Upside Target"
              value={move.upsideTarget}
              tone="bull"
              icon="▲"
            />
          </div>
          <div className="flex flex-col items-center rounded-md border border-amber-500/40 bg-amber-500/[0.06] py-1.5">
            <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-300">
              Max Pain
            </span>
            <span className="font-mono text-[22px] font-black tabular-nums text-amber-300">
              {move.maxPain ? move.maxPain.toLocaleString() : "—"}
            </span>
          </div>
        </div>
      </div>
    </V2Card>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * Level row — reused for each resistance / support tier
 * ───────────────────────────────────────────────────────────────────── */
function LevelRow({
  label, value, tone, first,
}: {
  label: string;
  value: number;
  tone: "bull" | "bear";
  first: boolean;
}) {
  const t = V2_TONE[tone];
  return (
    <div
      className={`flex items-center justify-between px-2.5 py-1 text-[12px] ${
        !first ? "border-t border-white/[0.04]" : ""
      }`}
    >
      <span className="text-white/75">{label}</span>
      <span className="font-mono text-[14px] font-bold tabular-nums" style={{ color: t.color }}>
        {value.toLocaleString()}
      </span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * Target tile — Downside / Upside in OI Estimated Move
 * ───────────────────────────────────────────────────────────────────── */
function TargetTile({
  label, value, tone, icon,
}: {
  label: string;
  value: number | null;
  tone: "bull" | "bear";
  icon: string;
}) {
  const t = V2_TONE[tone];
  return (
    <div
      className="flex flex-col items-center rounded-md border px-2 py-1.5"
      style={{ borderColor: t.border, background: t.soft }}
    >
      <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-[0.16em]" style={{ color: t.color }}>
        <span>{icon}</span>
        {label}
      </span>
      <span className="mt-0.5 font-mono text-[20px] font-black tabular-nums leading-none" style={{ color: t.color }}>
        {value ? value.toLocaleString() : "—"}
      </span>
    </div>
  );
}
