import type { IntelSnapshot } from "@/lib/intelTypes";
import { Card, fmt, fmtCompact, fmtSignedCompact } from "./common";
import { cn } from "@/lib/utils";

export function OptionChainSnapshotCard({ data }: { data: IntelSnapshot | null }) {
  if (!data) return <Card title="Option Chain Snapshot">…</Card>;
  const rows = data.dashboard?.optionChainSnapshot || [];
  const expiry = data.dashboard?.tradingDay?.expiry;

  return (
    <Card
      title={`Option Chain Snapshot${expiry ? ` (NIFTY ${_expiryShort(expiry)})` : ""}`}
    >
      <div className="grid h-full grid-cols-2 gap-3 overflow-hidden">
        {/* CALLS column */}
        <div className="flex min-h-0 flex-col">
          <div className="mb-1 text-center text-[9px] font-bold uppercase tracking-[0.18em] text-emerald-400">
            CALLS
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <table className="w-full text-[10px]">
            <thead>
              <tr className="border-b border-white/[0.06] text-[8px] uppercase tracking-wider text-white/35">
                <th className="py-0.5 text-right">OI</th>
                <th className="py-0.5 text-right">OI Chg</th>
                <th className="py-0.5 text-right">LTP</th>
                <th className="py-0.5 text-right">IV</th>
                <th className="py-0.5 text-right">Δ</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={`${r.strike}-ce`}
                  className={cn(
                    "border-b border-white/[0.03]",
                    r.isAtm && "bg-amber-500/5",
                  )}
                >
                  <td className="py-0.5 text-right font-mono">{fmtCompact(r.ce.oi)}</td>
                  <td className={`py-0.5 text-right font-mono ${r.ce.oiChg >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                    {fmtSignedCompact(r.ce.oiChg)}
                  </td>
                  <td className="py-0.5 text-right font-mono text-emerald-400">{fmt(r.ce.ltp, 2)}</td>
                  <td className="py-0.5 text-right font-mono">{fmt(r.ce.iv, 1)}</td>
                  <td className="py-0.5 text-right font-mono">{fmt(r.ce.delta, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>

        {/* PUTS column */}
        <div className="flex min-h-0 flex-col">
          <div className="mb-1 text-center text-[9px] font-bold uppercase tracking-[0.18em] text-rose-400">
            PUTS
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <table className="w-full text-[10px]">
            <thead>
              <tr className="border-b border-white/[0.06] text-[8px] uppercase tracking-wider text-white/35">
                <th className="py-0.5 text-left">Strike</th>
                <th className="py-0.5 text-right">Δ</th>
                <th className="py-0.5 text-right">IV</th>
                <th className="py-0.5 text-right">LTP</th>
                <th className="py-0.5 text-right">OI Chg</th>
                <th className="py-0.5 text-right">OI</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={`${r.strike}-pe`}
                  className={cn(
                    "border-b border-white/[0.03]",
                    r.isAtm && "bg-amber-500/10",
                  )}
                >
                  <td
                    className={cn(
                      "py-0.5 text-left font-mono font-bold",
                      r.isAtm ? "text-amber-400" : "text-white/85",
                    )}
                  >
                    {r.strike}
                  </td>
                  <td className="py-0.5 text-right font-mono">{fmt(r.pe.delta, 2)}</td>
                  <td className="py-0.5 text-right font-mono">{fmt(r.pe.iv, 1)}</td>
                  <td className="py-0.5 text-right font-mono text-rose-400">{fmt(r.pe.ltp, 2)}</td>
                  <td className={`py-0.5 text-right font-mono ${r.pe.oiChg >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                    {fmtSignedCompact(r.pe.oiChg)}
                  </td>
                  <td className="py-0.5 text-right font-mono">{fmtCompact(r.pe.oi)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      </div>
    </Card>
  );
}

function _expiryShort(date: string): string {
  // "2026-05-29" → "29 MAY 2026"
  try {
    const d = new Date(date);
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
  } catch {
    return date;
  }
}
