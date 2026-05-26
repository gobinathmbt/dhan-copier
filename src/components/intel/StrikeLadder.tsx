import type { IntelSnapshot, LadderRow } from "@/lib/intelTypes";
import { Panel } from "./Panel";
import { cn } from "@/lib/utils";

function fmt(n: number | null | undefined, d = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1e7) return `${(n / 1e7).toFixed(1)}Cr`;
  if (Math.abs(n) >= 1e5) return `${(n / 1e5).toFixed(1)}L`;
  if (Math.abs(n) >= 1e3 && d === 0) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

function oiHeat(change: number, max: number): string {
  if (!max) return "transparent";
  const pct = Math.min(1, Math.abs(change) / max);
  if (change > 0) return `rgba(16, 185, 129, ${0.08 + pct * 0.35})`;
  if (change < 0) return `rgba(239, 68, 68, ${0.08 + pct * 0.35})`;
  return "transparent";
}

function Cell({
  children,
  className,
  bg,
  align = "right",
}: {
  children: React.ReactNode;
  className?: string;
  bg?: string;
  align?: "left" | "right" | "center";
}) {
  return (
    <td
      className={cn(
        "relative whitespace-nowrap px-2 py-1 font-mono text-[11px] tabular-nums transition-colors",
        align === "right" && "text-right",
        align === "center" && "text-center",
        className,
      )}
      style={{ background: bg }}
    >
      {children}
    </td>
  );
}

function Row({
  row,
  maxOiChange,
  callWall,
  putWall,
}: {
  row: LadderRow;
  maxOiChange: number;
  callWall: number | null;
  putWall: number | null;
}) {
  const isCallWall = callWall === row.strike;
  const isPutWall = putWall === row.strike;
  return (
    <tr
      className={cn(
        "border-b border-white/[0.04] transition-colors hover:bg-white/[0.04]",
        row.isAtm && "bg-amber-500/5",
      )}
    >
      {/* CE side (left) */}
      <Cell bg={oiHeat(row.ce.oiChange, maxOiChange)}>
        {fmt(row.ce.oiChange, 0)}
      </Cell>
      <Cell>{fmt(row.ce.oi, 0)}</Cell>
      <Cell>{fmt(row.ce.iv, 1)}</Cell>
      <Cell>{fmt(row.ce.delta, 2)}</Cell>
      <Cell className="text-emerald-400 font-bold">{fmt(row.ce.ltp, 2)}</Cell>

      {/* Strike */}
      <Cell
        align="center"
        className={cn(
          "font-bold",
          row.isAtm ? "text-amber-400 bg-amber-500/10" : "text-white/85",
          isCallWall && "text-rose-400",
          isPutWall && "text-emerald-400",
        )}
      >
        {row.strike}
        {row.isAtm ? <span className="ml-1 text-[8px]">ATM</span> : null}
        {isCallWall ? <span className="ml-1 text-[8px]">CW</span> : null}
        {isPutWall ? <span className="ml-1 text-[8px]">PW</span> : null}
      </Cell>

      {/* PE side (right) */}
      <Cell className="text-rose-400 font-bold">{fmt(row.pe.ltp, 2)}</Cell>
      <Cell>{fmt(row.pe.delta, 2)}</Cell>
      <Cell>{fmt(row.pe.iv, 1)}</Cell>
      <Cell>{fmt(row.pe.oi, 0)}</Cell>
      <Cell bg={oiHeat(row.pe.oiChange, maxOiChange)}>
        {fmt(row.pe.oiChange, 0)}
      </Cell>
    </tr>
  );
}

export function StrikeLadder({ data }: { data: IntelSnapshot | null }) {
  if (!data || !data.ladder?.length) {
    return (
      <Panel title="Live Strike Ladder" className="h-full">
        <div className="flex h-full items-center justify-center text-xs text-white/30">
          waiting for option chain…
        </div>
      </Panel>
    );
  }

  const rows = data.ladder;
  const maxOiChange = Math.max(
    1,
    ...rows.flatMap((r) => [Math.abs(r.ce.oiChange || 0), Math.abs(r.pe.oiChange || 0)]),
  );

  return (
    <Panel
      title="Live Strike Ladder · ATM ±6"
      badge={
        <div className="flex items-center gap-2 text-[10px] text-white/45">
          <span className="font-mono">PCR {data.flow.oi.pcr.toFixed(2)}</span>
          <span className="font-mono text-amber-400">MP {data.options.maxPain || "—"}</span>
        </div>
      }
      className="h-full"
      scroll
      dense
    >
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-[#111114]/95 backdrop-blur-sm">
          <tr className="border-b border-white/[0.08] text-[9px] font-semibold uppercase tracking-wider text-white/40">
            <th className="px-2 py-1.5 text-right">ΔOI</th>
            <th className="px-2 py-1.5 text-right">OI</th>
            <th className="px-2 py-1.5 text-right">IV</th>
            <th className="px-2 py-1.5 text-right">Δ</th>
            <th className="px-2 py-1.5 text-right text-emerald-400">CE LTP</th>
            <th className="px-2 py-1.5 text-center">Strike</th>
            <th className="px-2 py-1.5 text-right text-rose-400">PE LTP</th>
            <th className="px-2 py-1.5 text-right">Δ</th>
            <th className="px-2 py-1.5 text-right">IV</th>
            <th className="px-2 py-1.5 text-right">OI</th>
            <th className="px-2 py-1.5 text-right">ΔOI</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Row
              key={r.strike}
              row={r}
              maxOiChange={maxOiChange}
              callWall={data.options.callWall}
              putWall={data.options.putWall}
            />
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
