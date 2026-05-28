import type { IntelV3Snapshot } from "@/lib/intelV3Types";
import { V3Card, V3Pill, V3_TONE, v3Fmt, V3StrengthBar } from "./common";

/* ────────────────────────────────────────────────────────────────────────
 * 1. MARKET INTENT SNAPSHOT
 * ──────────────────────────────────────────────────────────────────────── */
export function MarketIntentCard({ data }: { data: IntelV3Snapshot | null }) {
  const m = data?.marketIntent;
  const rows = [
    { icon: "💰", label: "Smart Money Side", value: m?.smartMoneySide || "—",
      tone: m?.smartMoneySide === "BUYERS" ? "bull" : m?.smartMoneySide === "SELLERS" ? "bear" : "warn" },
    { icon: "🐻", label: "CE Writers Activity", value: m?.ceWritersActivity.level || "—",
      tone: m?.ceWritersActivity.level === "Aggressive" ? "bear"
          : m?.ceWritersActivity.level === "Active" ? "warn" : "neutral" },
    { icon: "🐂", label: "PE Writers Activity", value: m?.peWritersActivity.level || "—",
      tone: m?.peWritersActivity.level === "Aggressive" ? "bull"
          : m?.peWritersActivity.level === "Active" ? "warn" : "neutral" },
    { icon: "📊", label: "OI Shift",
      value: m?.oiShift === "DOWNWARD" ? "DOWNWARD ↘" : m?.oiShift === "UPWARD" ? "UPWARD ↗" : "BALANCED",
      tone: m?.oiShift === "DOWNWARD" ? "bear" : m?.oiShift === "UPWARD" ? "bull" : "warn" },
    { icon: "📈", label: "Trend", value: m?.trend || "—",
      tone: m?.trend === "BULLISH" ? "bull" : m?.trend === "BEARISH" ? "bear" : "warn" },
    { icon: "📉", label: "Volatility (IV)", value: m?.ivTrend || "—",
      tone: m?.ivTrend === "Rising" ? "bull" : m?.ivTrend === "Falling" ? "bear" : "neutral" },
  ] as const;
  return (
    <V3Card title="Market Intent Snapshot" icon="🧭">
      <div className="flex flex-col gap-1">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center justify-between rounded-sm bg-white/[0.025] px-1.5 py-1">
            <span className="flex items-center gap-1 text-[10px] text-white/65">
              <span className="text-[11px]">{r.icon}</span>
              {r.label}
            </span>
            <span
              className="font-mono text-[11px] font-bold"
              style={{ color: V3_TONE[r.tone].color }}
            >
              {r.value}
            </span>
          </div>
        ))}
      </div>
    </V3Card>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * 2. STRONG RESISTANCE (CE Wall)
 * ──────────────────────────────────────────────────────────────────────── */
export function StrongResistanceCard({ data }: { data: IntelV3Snapshot | null }) {
  const walls = [...(data?.primary?.ceWalls || [])].sort((a, b) => a.strike - b.strike);
  return (
    <V3Card title="Strong Resistance (CE)" icon="🚧" accent="bear">
      <div className="flex flex-col gap-0.5">
        {walls.length === 0 && (
          <div className="px-1 py-2 text-center text-[10px] text-white/45">No data</div>
        )}
        {walls.map(w => (
          <div
            key={w.strike}
            className={`grid grid-cols-[58px_1fr_auto_auto] items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-[10px] ${
              w.isAtm ? "border border-rose-500/40 bg-rose-500/[0.05]" : ""
            }`}
          >
            <span className="font-mono font-bold text-white/90">
              {w.strike.toLocaleString()}
              {w.isAtm ? <span className="ml-0.5 text-[7px] text-sky-300">ATM</span> : null}
            </span>
            <span className="truncate text-[9px] text-rose-300">{w.strengthTag}</span>
            <V3StrengthBar pct={w.strengthPct} color={V3_TONE.bear.color} />
            {w.strengthTag === "Extreme"
              ? <V3Pill label="!" tone="bear" size="xs" filled />
              : <span className="w-3" />}
          </div>
        ))}
      </div>
    </V3Card>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * 3. STRONG SUPPORT (PE Wall)
 * ──────────────────────────────────────────────────────────────────────── */
export function StrongSupportCard({ data }: { data: IntelV3Snapshot | null }) {
  const walls = [...(data?.primary?.peWalls || [])].sort((a, b) => b.strike - a.strike);
  return (
    <V3Card title="Strong Support (PE)" icon="🛡️" accent="bull">
      <div className="flex flex-col gap-0.5">
        {walls.length === 0 && (
          <div className="px-1 py-2 text-center text-[10px] text-white/45">No data</div>
        )}
        {walls.map(w => (
          <div
            key={w.strike}
            className={`grid grid-cols-[58px_1fr_auto] items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-[10px] ${
              w.isAtm ? "border border-emerald-500/40 bg-emerald-500/[0.05]" : ""
            }`}
          >
            <span className="font-mono font-bold text-white/90">
              {w.strike.toLocaleString()}
              {w.isAtm ? <span className="ml-0.5 text-[7px] text-sky-300">ATM</span> : null}
            </span>
            <span className="truncate text-[9px] text-emerald-300">{w.strengthTag}</span>
            <V3StrengthBar pct={w.strengthPct} color={V3_TONE.bull.color} />
          </div>
        ))}
      </div>
    </V3Card>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * 4. BEST OPTION BUY (BIG center CTA)
 * ──────────────────────────────────────────────────────────────────────── */
export function BestOptionBuyCard({ data }: { data: IntelV3Snapshot | null }) {
  const b = data?.bestOptionBuy;
  if (!b) {
    return (
      <V3Card title="Best Option Buy" icon="🎯" accent="warn">
        <div className="flex h-full items-center justify-center text-[11px] text-white/45">
          Awaiting setup
        </div>
      </V3Card>
    );
  }
  const accent = b.side === "CE" ? "bull" : "bear";
  const accentColor = V3_TONE[accent].color;

  return (
    <V3Card
      title={<span>Best Option Buy <span className="ml-1 text-[8px] text-white/45">(High Probability)</span></span>}
      icon="🎯"
      accent={accent as "bull" | "bear"}
      glow
    >
      <div className="flex h-full min-h-0 flex-col items-center justify-between gap-1.5 py-1">
        {/* Recommended pill */}
        <div className="rounded-sm border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] text-white/65">
          Recommended
        </div>

        {/* BIG BUY label */}
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-[34px] font-black leading-none tracking-[0.06em]" style={{ color: accentColor }}>
            BUY {b.side}
          </span>
          <span className="text-[14px] font-bold text-white/90">
            Strike: <span style={{ color: accentColor }}>{b.strike.toLocaleString()} {b.side}</span>
          </span>
          <span
            className="rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
            style={{ background: accentColor + "22", color: accentColor }}
          >
            {b.setupTag} · {b.probability}%
          </span>
        </div>

        {/* 4 condition chips */}
        <div className="grid w-full grid-cols-4 gap-1">
          {b.conditions.map((c, i) => (
            <ConditionChip key={i} {...c} />
          ))}
        </div>

        {/* TARGETS */}
        <div className="w-full">
          <div className="mb-0.5 text-center text-[9px] font-bold uppercase tracking-[0.16em] text-white/55">
            Targets (Intraday)
          </div>
          <div className="grid grid-cols-3 gap-1">
            <TargetCell label="T1" value={b.targets.t1} accent={accentColor} />
            <TargetCell label="T2" value={b.targets.t2} accent={accentColor} />
            <TargetCell label="T3" value={b.targets.t3} accent={accentColor} />
          </div>
        </div>

        {/* SL */}
        <div className="w-full rounded-md border border-rose-500/30 bg-rose-500/[0.05] px-2 py-1 text-center">
          <div className="text-[9px] font-bold uppercase tracking-[0.16em] text-rose-300">SL (Stop Loss)</div>
          <div className="font-mono text-[14px] font-bold text-rose-400">
            {b.side === "CE" ? "Below" : "Above"} {b.stopLoss.toLocaleString()}
          </div>
        </div>
      </div>
    </V3Card>
  );
}

function ConditionChip({ label, value, tone }: {
  label: string;
  value: string;
  tone: "bull" | "bear" | "warn" | "neutral" | "info";
}) {
  const t = V3_TONE[tone];
  return (
    <div
      className="flex flex-col items-center rounded-md border px-1 py-1"
      style={{ borderColor: t.border, background: t.soft }}
    >
      <span className="text-center text-[8px] font-bold uppercase leading-tight tracking-wider text-white/65">
        {label}
      </span>
      <span className="mt-0.5 truncate text-center text-[10px] font-bold leading-tight" style={{ color: t.color }}>
        {value}
      </span>
    </div>
  );
}

function TargetCell({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div
      className="flex flex-col items-center rounded-md border px-1 py-0.5"
      style={{ borderColor: accent + "44", background: accent + "10" }}
    >
      <span className="text-[8px] font-bold uppercase tracking-[0.16em] text-white/55">{label}</span>
      <span className="font-mono text-[12px] font-bold tabular-nums" style={{ color: accent }}>
        {value.toLocaleString()}
      </span>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * 5. SHIFT & FLOW (Live)
 * ──────────────────────────────────────────────────────────────────────── */
export function ShiftFlowCard({ data }: { data: IntelV3Snapshot | null }) {
  const s = data?.shiftFlow;
  return (
    <V3Card title={<span>Shift & Flow <span className="text-[8px] text-white/45">(Live)</span></span>} icon="📡">
      <div className="grid grid-cols-2 gap-1">
        <ShiftCell label="CE OI" value={s?.ceOiChange.label || "—"}
                   trend={s?.ceOiChange.trend || ""} tone={s?.ceOiChange.tone || "neutral"} />
        <ShiftCell label="PE OI" value={s?.peOiChange.label || "—"}
                   trend={s?.peOiChange.trend || ""} tone={s?.peOiChange.tone || "neutral"} />
        <ShiftCell label="Net Shift" value={s?.netShift.label || "—"}
                   trend={s?.netShift.label2 || ""} tone={s?.netShift.tone || "neutral"} />
        <ShiftCell label="PCR" value={(s?.pcrTrend.value ?? 0).toFixed(2)}
                   trend={s?.pcrTrend.label || ""} tone={s?.pcrTrend.tone || "neutral"} />
      </div>
    </V3Card>
  );
}

function ShiftCell({ label, value, trend, tone }:
                   { label: string; value: string; trend: string; tone: "bull" | "bear" | "warn" | "neutral" | "info" }) {
  const t = V3_TONE[tone];
  return (
    <div
      className="rounded-md border px-1.5 py-1"
      style={{ borderColor: t.border, background: t.soft }}
    >
      <div className="text-[8px] font-bold uppercase tracking-[0.14em] text-white/55">{label}</div>
      <div className="mt-0.5 font-mono text-[12px] font-bold leading-tight tabular-nums" style={{ color: t.color }}>
        {value}
      </div>
      <div className="text-[9px] text-white/55">{trend}</div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * 6. TRAP & RISK ZONES
 * ──────────────────────────────────────────────────────────────────────── */
export function TrapRiskCard({ data }: { data: IntelV3Snapshot | null }) {
  const t = data?.trapZones;
  return (
    <V3Card title="Trap & Risk Zones" icon="⚠️" accent="warn">
      <div className="grid grid-cols-2 gap-1">
        {t?.bullTrap ? (
          <TrapCell
            label="BULL TRAP"
            sub="Avoid CE"
            range={`${t.bullTrap.lo.toLocaleString()} – ${t.bullTrap.hi.toLocaleString()}`}
            hint={t.bullTrap.hint}
            tone="bear"
          />
        ) : <div className="rounded-md border border-white/[0.06] bg-white/[0.02] p-1.5 text-center text-[9px] text-white/45">No bull trap</div>}
        {t?.bearTrap ? (
          <TrapCell
            label="BEAR TRAP"
            sub="Avoid PE"
            range={`${t.bearTrap.lo.toLocaleString()} – ${t.bearTrap.hi.toLocaleString()}`}
            hint={t.bearTrap.hint}
            tone="bull"
          />
        ) : <div className="rounded-md border border-white/[0.06] bg-white/[0.02] p-1.5 text-center text-[9px] text-white/45">No bear trap</div>}
      </div>
    </V3Card>
  );
}

function TrapCell({ label, sub, range, hint, tone }:
                  { label: string; sub: string; range: string; hint: string; tone: "bull" | "bear" }) {
  const t = V3_TONE[tone];
  return (
    <div
      className="rounded-md border px-1.5 py-1"
      style={{ borderColor: t.border, background: t.soft }}
    >
      <div className="text-[9px] font-bold uppercase tracking-wider" style={{ color: t.color }}>
        {label} <span className="text-[8px] text-white/45">{sub}</span>
      </div>
      <div className="mt-0.5 font-mono text-[12px] font-bold leading-tight tabular-nums text-white/90">{range}</div>
      <div className="mt-0.5 line-clamp-2 text-[9px] leading-tight text-white/65">{hint}</div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * 7. ALTERNATE SCENARIO
 * ──────────────────────────────────────────────────────────────────────── */
export function AlternateScenarioCard({ data }: { data: IntelV3Snapshot | null }) {
  const a = data?.alternateScenario;
  if (!a) {
    return (
      <V3Card title="Alternate Scenario" icon="🔁">
        <div className="flex h-full items-center justify-center text-[10px] text-white/45">No reversal scenario</div>
      </V3Card>
    );
  }
  const accent = a.side === "CE" ? "bull" : "bear";
  const c = V3_TONE[accent].color;
  return (
    <V3Card title={<span>Alternate <span className="text-[8px] text-white/45">(Reversal)</span></span>} icon="🔁" accent={accent as "bull" | "bear"}>
      <div className="flex h-full min-h-0 flex-col items-center justify-around gap-1">
        <div className="text-center text-[9px] leading-tight text-white/65">
          <span className="font-bold uppercase tracking-wider">If: </span>
          {a.condition}
        </div>
        <div className="flex flex-col items-center">
          <span className="text-[22px] font-black leading-none" style={{ color: c }}>{a.label}</span>
          <span className="text-[11px] font-bold text-white/90">
            <span style={{ color: c }}>{a.strike.toLocaleString()} {a.side}</span>
          </span>
        </div>
        <div className="grid w-full grid-cols-3 gap-1">
          <SmallTarget label="T1" v={a.targets.t1} c={c} />
          <SmallTarget label="T2" v={a.targets.t2} c={c} />
          <SmallTarget label="T3" v={a.targets.t3} c={c} />
        </div>
      </div>
    </V3Card>
  );
}

function SmallTarget({ label, v, c }: { label: string; v: number; c: string }) {
  return (
    <div
      className="flex flex-col items-center rounded-sm border px-1 py-0.5"
      style={{ borderColor: c + "44", background: c + "10" }}
    >
      <span className="text-[7px] uppercase tracking-wider text-white/55">{label}</span>
      <span className="font-mono text-[10px] font-bold tabular-nums" style={{ color: c }}>{v.toLocaleString()}</span>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * 8. SMART MONEY FLOW
 * ──────────────────────────────────────────────────────────────────────── */
export function SmartMoneyFlowCard({ data }: { data: IntelV3Snapshot | null }) {
  const s = data?.smartMoneyFlow;
  return (
    <V3Card title="Smart Money Flow" icon="💼">
      <div className="flex flex-col gap-0.5">
        {(s?.metrics || []).map((m, i) => {
          const tone = m.level === "High" ? "bull"
            : m.level === "Moderate" ? "warn" : "neutral";
          return (
            <div key={i} className="flex items-center justify-between rounded-sm bg-white/[0.025] px-1.5 py-0.5 text-[10px]">
              <span className="truncate text-white/65">{m.label}</span>
              <span className="flex items-center gap-1">
                <span className="font-bold text-[10px]" style={{ color: V3_TONE[tone].color }}>{m.level}</span>
                <V3StrengthBar pct={m.level === "High" ? 90 : m.level === "Moderate" ? 55 : 25}
                               color={V3_TONE[tone].color} />
              </span>
            </div>
          );
        })}
        <div className="mt-1 grid grid-cols-2 gap-1 text-[9px]">
          <div className="rounded-sm bg-white/[0.025] px-1.5 py-1">
            <div className="text-white/55">Writers Zone</div>
            <div className="font-mono font-bold text-rose-300">{s?.writersActiveZone.label || "—"}</div>
          </div>
          <div className="rounded-sm bg-white/[0.025] px-1.5 py-1">
            <div className="text-white/55">Buyers Zone</div>
            <div className="font-mono font-bold text-emerald-300">{s?.buyersActiveZone.label || "—"}</div>
          </div>
        </div>
      </div>
    </V3Card>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * 9. SR QUICK VIEW
 * ──────────────────────────────────────────────────────────────────────── */
export function SRQuickViewCard({ data }: { data: IntelV3Snapshot | null }) {
  const s = data?.srQuickView;
  return (
    <V3Card title="S/R Quick View" icon="🔍">
      <div className="flex h-full flex-col justify-between gap-1">
        <div>
          <div className="mb-0.5 text-[9px] font-bold uppercase tracking-wider text-rose-400">CE Resistance</div>
          <div className="grid grid-cols-4 gap-0.5">
            {(s?.ce || []).map(w => (
              <SRChip key={w.strike} strike={w.strike} tag={w.tag} tone="bear" />
            ))}
          </div>
        </div>
        <div className="flex flex-col items-center rounded-md border border-sky-500/30 bg-sky-500/[0.05] py-0.5">
          <span className="font-mono text-[12px] font-bold text-sky-300">{v3Fmt(s?.spot, 2)}</span>
          <span className="text-[8px] uppercase tracking-wider text-white/55">SPOT</span>
        </div>
        <div>
          <div className="mb-0.5 text-[9px] font-bold uppercase tracking-wider text-emerald-400">PE Support</div>
          <div className="grid grid-cols-4 gap-0.5">
            {(s?.pe || []).map(w => (
              <SRChip key={w.strike} strike={w.strike} tag={w.tag} tone="bull" />
            ))}
          </div>
        </div>
      </div>
    </V3Card>
  );
}

function SRChip({ strike, tag, tone }: { strike: number; tag: string; tone: "bull" | "bear" }) {
  const t = V3_TONE[tone];
  return (
    <div
      className="flex flex-col items-center rounded-sm border px-0.5 py-0.5"
      style={{ borderColor: t.border, background: t.soft }}
    >
      <span className="font-mono text-[10px] font-bold leading-none" style={{ color: t.color }}>{strike}</span>
      <span className="truncate text-[7px] uppercase leading-tight text-white/55">{tag}</span>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * 10. TREND & MOMENTUM
 * ──────────────────────────────────────────────────────────────────────── */
export function TrendMomentumCard({ data }: { data: IntelV3Snapshot | null }) {
  const t = data?.trendMomentum;
  const angle = ((t?.needleAngle ?? 0) / 100) * 90;
  const dirColor = t?.direction === "BULLISH" ? V3_TONE.bull.color
    : t?.direction === "BEARISH" ? V3_TONE.bear.color : V3_TONE.warn.color;
  return (
    <V3Card title="Trend & Momentum" icon="📊">
      <div className="flex h-full flex-col items-center justify-center gap-0.5">
        <div className="relative h-16 w-32">
          <svg viewBox="0 0 200 110" className="h-full w-full" preserveAspectRatio="xMidYMid meet">
            <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="14" />
            <path d="M 20 100 A 80 80 0 0 1 75 30"   fill="none" stroke={V3_TONE.bear.color + "AA"} strokeWidth="14" />
            <path d="M 75 30 A 80 80 0 0 1 125 30"   fill="none" stroke={V3_TONE.warn.color + "AA"} strokeWidth="14" />
            <path d="M 125 30 A 80 80 0 0 1 180 100" fill="none" stroke={V3_TONE.bull.color + "AA"} strokeWidth="14" />
            <line
              x1="100" y1="100"
              x2={100 + 70 * Math.cos((Math.PI / 180) * (180 + angle))}
              y2={100 + 70 * Math.sin((Math.PI / 180) * (180 + angle))}
              stroke="#fff" strokeWidth="3" strokeLinecap="round"
            />
            <circle cx="100" cy="100" r="5" fill="#fff" />
          </svg>
        </div>
        <div className="text-[16px] font-black tracking-wider leading-none" style={{ color: dirColor }}>{t?.direction || "—"}</div>
        <div className="text-[10px] text-white/65">
          Momentum: <span className="font-bold" style={{ color: dirColor }}>{t?.momentum || "—"}</span>
        </div>
        <div className="text-[9px] text-white/45">Trend: {t?.trendStrength}</div>
      </div>
    </V3Card>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * 11. KEY LEVELS
 * ──────────────────────────────────────────────────────────────────────── */
export function KeyLevelsCard({ data }: { data: IntelV3Snapshot | null }) {
  const lvls = data?.keyLevels || [];
  return (
    <V3Card title={<span>Key Levels <span className="text-[8px] text-white/45">(Intraday)</span></span>} icon="📍">
      <div className="flex flex-col gap-0.5">
        {lvls.length === 0 && (
          <div className="px-1 py-2 text-center text-[10px] text-white/45">Loading…</div>
        )}
        {lvls.map((l, i) => {
          const tone = l.kind === "support" ? "bull" : l.kind === "resistance" ? "bear" : "neutral";
          const color = V3_TONE[tone].color;
          return (
            <div key={i} className="grid grid-cols-[16px_1fr_auto_44px] items-center gap-1 rounded-sm bg-white/[0.025] px-1.5 py-0.5 text-[10px]">
              <span className="text-[10px]">{l.kind === "support" ? "🟢" : l.kind === "resistance" ? "🔴" : "🔹"}</span>
              <span className="truncate text-white/65">{l.label}</span>
              <span className="font-mono text-[10px] font-bold text-white/90">{v3Fmt(l.value, 2)}</span>
              <span className="text-right text-[9px] font-bold" style={{ color }}>{l.relation}</span>
            </div>
          );
        })}
      </div>
    </V3Card>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * 12. CONFIDENCE METER
 * ──────────────────────────────────────────────────────────────────────── */
export function ConfidenceMeterCard({ data }: { data: IntelV3Snapshot | null }) {
  const c = data?.confidence;
  const score = c?.score ?? 0;
  const color =
    score >= 75 ? V3_TONE.bull.color
    : score >= 60 ? "#84cc16"
    : score >= 45 ? V3_TONE.warn.color
    : score >= 30 ? "#f97316"
    : V3_TONE.bear.color;
  const strokeDasharray = 251;
  const offset = strokeDasharray - (strokeDasharray * score) / 100;
  return (
    <V3Card title="Confidence Meter" icon="🎚️">
      <div className="flex h-full flex-col items-center justify-center gap-0.5">
        <div className="relative h-20 w-20">
          <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
            <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="8" />
            <circle
              cx="50" cy="50" r="40" fill="none"
              stroke={color} strokeWidth="8" strokeLinecap="round"
              strokeDasharray={strokeDasharray}
              strokeDashoffset={offset}
              style={{ transition: "stroke-dashoffset 0.6s ease, stroke 0.4s ease" }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-mono text-[20px] font-black leading-none" style={{ color }}>{score}%</span>
          </div>
        </div>
        <div className="text-center text-[10px] font-bold uppercase tracking-wider" style={{ color }}>
          {c?.label || "—"}
        </div>
        <div className="text-[9px] text-white/55">
          Side: <span className="font-bold" style={{ color }}>{c?.side === "CE" ? "Upside" : "Downside"}</span>
        </div>
      </div>
    </V3Card>
  );
}
