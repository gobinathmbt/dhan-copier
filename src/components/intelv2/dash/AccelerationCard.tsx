import type { IntelV2Snapshot } from "@/lib/intelV2Types";

/**
 * 🏎️ CE / PE ACCELERATION — twin half-circle (180°) speedometers.
 * ========================================================================
 * Sits to the LEFT of the AI Execution Engine card. Reads premium-momentum
 * + delta + flow data and renders TWO 180° gauges:
 *
 *   • LEFT  gauge — CE Acceleration (green) — % bullish-side push
 *   • RIGHT gauge — PE Acceleration (red)   — % bearish-side push
 *
 * Each gauge is a half-circle SVG arc with a needle. Score = composite of:
 *   1. CE/PE expansion %  (weight 40)  — clamped from premiumMomentum
 *   2. Delta flow share   (weight 25)  — call-buy vs call-sell etc.
 *   3. Writer pressure    (weight 20)  — peWriting boosts CE; ceWriting boosts PE
 *   4. Buyer/Seller side  (weight 15)  — dominance vs direction
 *
 * Both scores are independent (CE can be 70 while PE is 60 if both sides are
 * fighting). Tone band on each meter:
 *     0–35   → SLOW    (gray)
 *     36–60  → MODERATE (warn / amber)
 *     61–85  → FAST    (bull/bear)
 *     86–100 → REDLINE (bright)
 */
export function AccelerationCard({ data }: { data: IntelV2Snapshot | null }) {
  const pm = data?.dashboard?.premiumMomentum;
  const fr = data?.dashboard?.frvpInstitutional?.engine;
  const flow = fr?.flow;
  const oi  = data?.flow?.oi;

  if (!pm) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-white/[0.08] bg-[#0e1117] px-4 py-3 text-[12px] text-white/40">
        Acceleration engine warming up…
      </div>
    );
  }

  // ── Component-1 expansion (40 pts) ───────────────────────────────────
  const ceExp = clamp(pm.ceExpansionPct, -50, 100);
  const peExp = clamp(pm.peExpansionPct, -50, 100);
  const cePts1 = ceExp > 0 ? Math.min(40, ceExp * 1.3) : 0;
  const pePts1 = peExp > 0 ? Math.min(40, peExp * 1.3) : 0;

  // ── Component-2 directional flow (25 pts) ────────────────────────────
  // Bullish vol = CE buyers + PE sellers; bearish vol = CE sellers + PE buyers.
  const bullVol = (flow?.ceBuy ?? 0) + (flow?.peSell ?? 0);
  const bearVol = (flow?.ceSell ?? 0) + (flow?.peBuy ?? 0);
  const totalVol = bullVol + bearVol || 1;
  const bullShare = (bullVol / totalVol) * 100;
  const bearShare = (bearVol / totalVol) * 100;
  const cePts2 = (bullShare / 100) * 25;
  const pePts2 = (bearShare / 100) * 25;

  // ── Component-3 writer pressure (20 pts) ─────────────────────────────
  // PE writing = bullish for CE (writers betting price holds → CE works)
  // CE writing = bearish for PE (writers betting price stays under → PE works)
  const cePts3 = oi?.peWriting ? 20 : oi?.peUnwinding ? 5 : 10;
  const pePts3 = oi?.ceWriting ? 20 : oi?.ceUnwinding ? 5 : 10;

  // ── Component-4 buyer/seller dominance (15 pts) ──────────────────────
  const buyersPct  = fr?.dominance?.buyersScore  ?? 50;
  const sellersPct = fr?.dominance?.sellersScore ?? 50;
  const cePts4 = (buyersPct  / 100) * 15;
  const pePts4 = (sellersPct / 100) * 15;

  // ── Compose scores (0..100) ──────────────────────────────────────────
  const ceScore = Math.round(cePts1 + cePts2 + cePts3 + cePts4);
  const peScore = Math.round(pePts1 + pePts2 + pePts3 + pePts4);

  return (
    <div className="relative flex h-full min-h-0 flex-col gap-2 overflow-hidden rounded-lg border border-white/[0.08] bg-[#0e1117] px-3 py-2.5">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-[0.20em] text-sky-300">
          <span className="text-[16px]">🏎️</span>
          CE / PE Acceleration
        </span>
        <span className="text-[10px] font-normal text-white/45">
          (180° speedometers)
        </span>
      </div>

      {/* Twin gauges side-by-side */}
      <div className="grid flex-1 grid-cols-2 items-center gap-2">
        <Gauge title="CE" score={ceScore} side="bull" />
        <Gauge title="PE" score={peScore} side="bear" />
      </div>

      {/* Footer — quick component breakdown */}
      <div className="grid grid-cols-2 gap-2 text-[10px]">
        <ComponentRow tone="bull" exp={ceExp} flow={Math.round(bullShare)} writer={oi?.peWriting ? "PE Writing" : "—"} />
        <ComponentRow tone="bear" exp={peExp} flow={Math.round(bearShare)} writer={oi?.ceWriting ? "CE Writing" : "—"} />
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * 180° gauge — bottom-half of a circle with a needle.
 * Needle angle: 0 = far LEFT (slow), 180 = far RIGHT (redline).
 * ───────────────────────────────────────────────────────────────────── */
function Gauge({
  title, score, side,
}: {
  title: string;
  score: number;
  side: "bull" | "bear";
}) {
  const v = clamp(score, 0, 100);
  const angle = (v / 100) * 180;          // 0..180 deg
  const radians = ((angle - 180) * Math.PI) / 180;

  // SVG dimensions: viewBox 200x110 — half-circle from (10,100) to (190,100)
  const r = 90;
  const cx = 100;
  const cy = 100;
  // Needle endpoint
  const needleLen = 78;
  const nx = cx + needleLen * Math.cos(radians);
  const ny = cy + needleLen * Math.sin(radians);

  // Arc path — semicircle from far-left to far-right (drawn clockwise)
  const arcPath = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;

  // Tone bands: SLOW (gray) | MODERATE (amber) | FAST (side) | REDLINE (bright)
  const baseColor = side === "bull" ? "#22c55e" : "#ef4444";
  const fastFill = `${baseColor}cc`;
  const redlineFill = side === "bull" ? "#10b981" : "#dc2626";

  const label =
    v <= 35 ? "SLOW"
    : v <= 60 ? "MODERATE"
    : v <= 85 ? "FAST"
    : "REDLINE";
  const labelColor =
    v <= 35 ? "rgba(255,255,255,0.55)"
    : v <= 60 ? "#facc15"
    : v <= 85 ? baseColor
    : redlineFill;

  // Tick marks every 30deg (0, 30, 60, 90, 120, 150, 180)
  const ticks = [0, 30, 60, 90, 120, 150, 180];

  return (
    <div className="flex flex-col items-center justify-center gap-1">
      <svg viewBox="0 0 200 120" className="w-full max-w-[180px]">
        {/* Track (gray full arc) */}
        <path d={arcPath} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="14" strokeLinecap="round" />
        {/* Tone bands — use stroke-dasharray to paint segments */}
        {/* SLOW band: 0..35 deg of 180  → 0..63 of arc length (πr ≈ 283) */}
        <path
          d={arcPath}
          fill="none"
          stroke="rgba(156,163,175,0.55)"
          strokeWidth="14"
          strokeLinecap="butt"
          strokeDasharray="99 9999"
        />
        {/* MODERATE band: 35..60 → 99..170 (length 71) */}
        <path
          d={arcPath}
          fill="none"
          stroke="#f59e0b"
          strokeWidth="14"
          strokeLinecap="butt"
          strokeDasharray="71 9999"
          strokeDashoffset={-99}
        />
        {/* FAST band: 60..85 → 170..240 (length 70) */}
        <path
          d={arcPath}
          fill="none"
          stroke={fastFill}
          strokeWidth="14"
          strokeLinecap="butt"
          strokeDasharray="70 9999"
          strokeDashoffset={-170}
        />
        {/* REDLINE: 85..100 → 240..283 (length 43) */}
        <path
          d={arcPath}
          fill="none"
          stroke={redlineFill}
          strokeWidth="14"
          strokeLinecap="butt"
          strokeDasharray="43 9999"
          strokeDashoffset={-240}
        />
        {/* Ticks */}
        {ticks.map((t) => {
          const tr = ((t - 180) * Math.PI) / 180;
          const x1 = cx + (r - 10) * Math.cos(tr);
          const y1 = cy + (r - 10) * Math.sin(tr);
          const x2 = cx + (r + 4) * Math.cos(tr);
          const y2 = cy + (r + 4) * Math.sin(tr);
          return (
            <line key={t} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(255,255,255,0.35)" strokeWidth="1.4" />
          );
        })}
        {/* Needle */}
        <line
          x1={cx}
          y1={cy}
          x2={nx}
          y2={ny}
          stroke="#ffffff"
          strokeWidth="3"
          strokeLinecap="round"
          style={{
            filter: `drop-shadow(0 0 4px ${baseColor})`,
            transition: "all 0.5s ease",
          }}
        />
        {/* Hub */}
        <circle cx={cx} cy={cy} r="6" fill={baseColor} />
        <circle cx={cx} cy={cy} r="3" fill="#0e1117" />
      </svg>
      {/* Score + side */}
      <div className="-mt-2 flex flex-col items-center">
        <div className="flex items-baseline gap-1.5">
          <span
            className="font-mono text-[28px] font-black leading-none tabular-nums"
            style={{ color: baseColor }}
          >
            {v}
          </span>
          <span
            className="text-[12px] font-bold uppercase tracking-wider"
            style={{ color: baseColor, opacity: 0.7 }}
          >
            {title}
          </span>
        </div>
        <span
          className="mt-1 rounded-sm px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
          style={{ background: `${labelColor}1a`, color: labelColor }}
        >
          {label}
        </span>
      </div>
    </div>
  );
}

function ComponentRow({
  tone, exp, flow, writer,
}: {
  tone: "bull" | "bear";
  exp: number;
  flow: number;
  writer: string;
}) {
  const c = tone === "bull" ? "#22c55e" : "#ef4444";
  return (
    <div
      className="flex items-center justify-between rounded-sm border px-2 py-1"
      style={{ borderColor: `${c}30`, background: `${c}08` }}
    >
      <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: c }}>
        {tone === "bull" ? "CE" : "PE"}
      </span>
      <div className="flex items-center gap-2 font-mono text-[10px] tabular-nums text-white/75">
        <span title="Premium expansion %">Δ{exp >= 0 ? "+" : ""}{exp}%</span>
        <span title="Directional flow share">{flow}%</span>
        <span title="Writer state" className="truncate text-[9px] text-white/55">{writer}</span>
      </div>
    </div>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
