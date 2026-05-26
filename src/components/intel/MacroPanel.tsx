import type { IntelSnapshot } from "@/lib/intelTypes";
import { Panel } from "./Panel";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

function fmt(n: number | null | undefined, d = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

function MacroChip({
  label,
  price,
  changePct,
  hint,
  invertColor,
}: {
  label: string;
  price: number | null | undefined;
  changePct: number | null | undefined;
  hint?: string;
  invertColor?: boolean;
}) {
  const c = Number.isFinite(changePct) ? Number(changePct) : 0;
  const positive = c >= 0;
  // For things like VIX or DXY where rising = risk-off, invert color logic.
  const goodForBull = invertColor ? !positive : positive;
  const color = !Number.isFinite(price)
    ? "#6b7280"
    : goodForBull
      ? "#10b981"
      : "#ef4444";
  const icon = !Number.isFinite(price) ? <Minus size={10} /> : positive ? <TrendingUp size={10} /> : <TrendingDown size={10} />;
  return (
    <div
      className="flex flex-col gap-0.5 rounded-md border bg-black/25 px-2 py-1.5"
      style={{ borderColor: `${color}30` }}
      title={hint}
    >
      <div className="flex items-center justify-between text-[9px] uppercase tracking-[0.14em] text-white/45">
        <span>{label}</span>
        <span style={{ color }}>{icon}</span>
      </div>
      <div className="font-mono text-xs font-bold text-white">{fmt(price, 2)}</div>
      <div className={cn("font-mono text-[10px]")} style={{ color }}>
        {Number.isFinite(changePct) ? `${positive ? "+" : ""}${fmt(changePct, 2)}%` : "—"}
      </div>
    </div>
  );
}

export function MacroPanel({ data }: { data: IntelSnapshot | null }) {
  if (!data) {
    return (
      <Panel title="Macro Context" className="h-full">
        <div className="flex h-full items-center justify-center text-xs text-white/30">
          loading…
        </div>
      </Panel>
    );
  }
  const m = data.macro;

  // FII/DII summary
  const fiiCash = m?.fiiDii?.cash?.fii?.buy_sell_difference ?? null;
  const diiCash = m?.fiiDii?.cash?.dii?.buy_sell_difference ?? null;
  const fiiAction = m?.fiiDii?.cash?.fii?.net_action ?? "—";
  const diiAction = m?.fiiDii?.cash?.dii?.net_action ?? "—";

  return (
    <Panel
      title="Macro Context"
      badge={<span className="text-[10px] text-white/40">premarket / overnight</span>}
      className="h-full"
    >
      <div className="space-y-2">
        <div className="grid grid-cols-3 gap-1.5">
          <MacroChip
            label="India VIX"
            price={m?.vix?.price}
            changePct={m?.vix?.changePct}
            invertColor
            hint="Rising VIX = risk-off / option prices expanding"
          />
          <MacroChip
            label="GIFT NIFTY"
            price={m?.giftNifty?.price}
            changePct={m?.giftNifty?.changePct}
            hint="NSE IFSC overnight proxy"
          />
          <MacroChip
            label="DXY"
            price={m?.dxy?.price}
            changePct={m?.dxy?.changePct}
            invertColor
            hint="Strong dollar = FII outflow risk"
          />
          <MacroChip
            label="SP500 Fut"
            price={m?.usFutures?.sp500?.price}
            changePct={m?.usFutures?.sp500?.changePct}
            hint="US futures bullish/bearish"
          />
          <MacroChip
            label="Nasdaq Fut"
            price={m?.usFutures?.nasdaq?.price}
            changePct={m?.usFutures?.nasdaq?.changePct}
          />
          <MacroChip
            label="Crude Oil"
            price={m?.crude?.price}
            changePct={m?.crude?.changePct}
            invertColor
            hint="Rising crude = inflationary, negative for India"
          />
        </div>

        {/* FII / DII */}
        <div className="rounded-md border border-white/[0.06] bg-black/25 p-2">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/55">
            FII / DII Cash Flow
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <FiiDiiRow label="FII" value={fiiCash} action={fiiAction} />
            <FiiDiiRow label="DII" value={diiCash} action={diiAction} />
          </div>
          {fiiCash != null && diiCash != null ? (
            <div className="mt-1 text-[10px] text-white/45">
              Net: {fmt(fiiCash + diiCash, 0)} Cr
            </div>
          ) : null}
        </div>

        {/* Heavyweights */}
        {data.heavyweights?.rows?.length ? (
          <div className="rounded-md border border-white/[0.06] bg-black/25 p-2">
            <div className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.14em] text-white/55">
              <span>NIFTY Heavyweights</span>
              <span
                className={cn(
                  "font-mono",
                  data.heavyweights.weightedAvgChangePct >= 0 ? "text-emerald-400" : "text-rose-400",
                )}
              >
                wt avg {data.heavyweights.weightedAvgChangePct >= 0 ? "+" : ""}
                {fmt(data.heavyweights.weightedAvgChangePct, 2)}%
              </span>
            </div>
            <div className="space-y-0.5">
              {data.heavyweights.rows.map((r) => {
                const c = Number(r.changePct ?? 0);
                const color = c >= 0 ? "#10b981" : "#ef4444";
                const barWidth = Math.min(100, Math.abs(c) * 25);
                return (
                  <div
                    key={r.symbol}
                    className="grid grid-cols-12 items-center gap-2 text-[11px]"
                  >
                    <span className="col-span-3 truncate text-white/65" title={r.name}>
                      {r.name}
                    </span>
                    <span className="col-span-2 font-mono text-[10px] text-white/40">
                      {r.weight}%
                    </span>
                    <span className="col-span-4">
                      <span
                        className="block h-1 rounded-full"
                        style={{
                          width: `${barWidth}%`,
                          background: color,
                          marginLeft: c < 0 ? "auto" : 0,
                          marginRight: c < 0 ? 0 : "auto",
                        }}
                      />
                    </span>
                    <span
                      className="col-span-3 text-right font-mono tabular-nums"
                      style={{ color }}
                    >
                      {c >= 0 ? "+" : ""}
                      {fmt(c, 2)}%
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

function FiiDiiRow({
  label,
  value,
  action,
}: {
  label: string;
  value: number | null;
  action: string;
}) {
  const positive = value != null && value > 0;
  const color = value == null ? "#6b7280" : positive ? "#10b981" : "#ef4444";
  return (
    <div
      className="flex flex-col rounded border bg-black/30 px-2 py-1"
      style={{ borderColor: `${color}30` }}
    >
      <div className="flex items-center justify-between text-[9px] uppercase tracking-wider text-white/40">
        <span>{label}</span>
        <span style={{ color }}>{action}</span>
      </div>
      <div className="font-mono text-sm font-bold" style={{ color }}>
        {value != null ? `${positive ? "+" : ""}${fmt(value, 0)}` : "—"}
        <span className="ml-1 text-[10px] font-normal text-white/45">Cr</span>
      </div>
    </div>
  );
}
