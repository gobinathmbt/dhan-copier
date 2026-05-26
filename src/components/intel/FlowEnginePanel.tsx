import type { IntelSnapshot } from "@/lib/intelTypes";
import { Panel, StatRow } from "./Panel";
import { biasColor } from "./colors";
import { ArrowDown, ArrowUp, Activity, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

function fmt(n: number | null | undefined, d = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

function MeterBar({
  value,
  label,
  hint,
  tone,
}: {
  value: number;
  label: string;
  hint?: string;
  tone?: "bull" | "bear" | "neutral";
}) {
  const v = Math.max(0, Math.min(100, value));
  const color = tone === "bull" ? "#10b981" : tone === "bear" ? "#ef4444" : "#9ca3af";
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/55">
          {label}
        </span>
        <span className="font-mono text-xs font-bold tabular-nums" style={{ color }}>
          {Math.round(v)}
        </span>
      </div>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="absolute left-1/2 top-0 h-full bg-white/15"
          style={{ width: 1, transform: "translateX(-0.5px)" }}
        />
        <div
          className="h-full transition-all duration-500"
          style={{
            width: `${v}%`,
            background: color,
            boxShadow: `0 0 8px ${color}`,
          }}
        />
      </div>
      {hint ? <div className="text-[10px] text-white/35">{hint}</div> : null}
    </div>
  );
}

function DirectionalArrow({ bias }: { bias: string }) {
  if (bias === "bullish")
    return (
      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400 animate-pulse">
        <ArrowUp size={12} />
      </span>
    );
  if (bias === "bearish")
    return (
      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-500/20 text-rose-400 animate-pulse">
        <ArrowDown size={12} />
      </span>
    );
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/10 text-white/40">
      <Activity size={12} />
    </span>
  );
}

export function FlowEnginePanel({ data }: { data: IntelSnapshot | null }) {
  if (!data) {
    return (
      <Panel title="Flow Engine" className="h-full">
        <div className="flex h-full items-center justify-center text-xs text-white/30">
          loading…
        </div>
      </Panel>
    );
  }

  const flow = data.flow;
  const fut = data.futures;

  return (
    <Panel
      title="Flow Engine"
      badge={
        <span className="text-[10px] font-mono text-white/40">
          {fut.available ? "live" : "no fut"}
        </span>
      }
      className="h-full"
      scroll
    >
      <div className="space-y-3">
        {/* Delta velocity */}
        <div
          className={cn(
            "rounded-md border p-2.5",
            flow.delta.flip || flow.delta.exhaustion
              ? "border-amber-500/30 bg-amber-500/5"
              : "border-white/[0.06] bg-black/20",
          )}
        >
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Zap size={12} className="text-amber-400" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/55">
                Delta Velocity
              </span>
            </div>
            <DirectionalArrow bias={flow.delta.bias} />
          </div>
          <MeterBar
            value={flow.delta.velocityScore}
            label={(flow.delta.velocityState || "—").replace(/_/g, " ")}
            tone={
              flow.delta.bias === "bullish"
                ? "bull"
                : flow.delta.bias === "bearish"
                  ? "bear"
                  : "neutral"
            }
          />
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5">
            <StatRow label="CVD %" value={fmt(flow.delta.cvd, 2)} tone={flow.delta.bias === "bullish" ? "bull" : flow.delta.bias === "bearish" ? "bear" : "neutral"} />
            <StatRow label="Velocity" value={fmt(flow.delta.velocity, 0)} />
            <StatRow label="Accel" value={fmt(flow.delta.acceleration, 0)} />
            <StatRow label="Trend" value={flow.delta.trend} />
            {flow.delta.flip ? (
              <StatRow label="Flip" value="DETECTED" tone="warn" />
            ) : null}
            {flow.delta.exhaustion ? (
              <StatRow label="Exhaustion" value="DETECTED" tone="warn" />
            ) : null}
          </div>
        </div>

        {/* Futures leadership */}
        <div className="rounded-md border border-white/[0.06] bg-black/20 p-2.5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/55">
              Futures Leadership
            </span>
            <DirectionalArrow bias={fut.direction} />
          </div>
          <MeterBar
            value={fut.leadLagScore}
            label={`${fut.leadLagScore > 60 ? "leading bull" : fut.leadLagScore < 40 ? "leading bear" : "synced"}`}
            tone={fut.leadLagScore > 60 ? "bull" : fut.leadLagScore < 40 ? "bear" : "neutral"}
          />
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5">
            <StatRow label="Fut LTP" value={fmt(fut.ltp)} />
            <StatRow
              label="Basis"
              value={`${fut.basis >= 0 ? "+" : ""}${fmt(fut.basis, 1)}`}
              tone={fut.basis >= 0 ? "bull" : "bear"}
            />
            <StatRow label="Basis state" value={fut.basisState} />
            <StatRow label="Score" value={fmt(fut.score, 0)} tone="info" />
            {fut.aggressive ? (
              <StatRow label="Aggressive bar" value="YES" tone="bull" />
            ) : null}
          </div>
        </div>

        {/* OI shift / flow */}
        <div className="rounded-md border border-white/[0.06] bg-black/20 p-2.5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/55">
              OI Shift &amp; Velocity
            </span>
            <span className="font-mono text-[10px] text-white/45">PCR {fmt(flow.oi.pcr, 2)}</span>
          </div>
          <MeterBar
            value={flow.oi.qualityScore}
            label="OI Quality"
            tone={flow.oi.qualityScore >= 60 ? "bull" : flow.oi.qualityScore <= 40 ? "bear" : "neutral"}
          />
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5">
            <StatRow
              label="PE Writing"
              value={flow.oi.peWriting ? "YES" : "—"}
              tone={flow.oi.peWriting ? "bull" : "neutral"}
              hint="Bullish — put writers active"
            />
            <StatRow
              label="CE Writing"
              value={flow.oi.ceWriting ? "YES" : "—"}
              tone={flow.oi.ceWriting ? "bear" : "neutral"}
              hint="Bearish — call writers active"
            />
            <StatRow
              label="CE Unwind"
              value={flow.oi.ceUnwinding ? "YES" : "—"}
              tone={flow.oi.ceUnwinding ? "bull" : "neutral"}
              hint="Short covering on CE"
            />
            <StatRow
              label="PE Unwind"
              value={flow.oi.peUnwinding ? "YES" : "—"}
              tone={flow.oi.peUnwinding ? "bear" : "neutral"}
              hint="Long unwinding on PE"
            />
            <StatRow label="Velocity" value={fmt(flow.oi.velocity, 0)} />
            <StatRow label="Accel" value={fmt(flow.oi.acceleration, 0)} />
          </div>
        </div>

        {/* Volume / FRVP */}
        <div className="rounded-md border border-white/[0.06] bg-black/20 p-2.5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/55">
              Volume &amp; FRVP
            </span>
            <span
              className="font-mono text-[10px] uppercase"
              style={{ color: biasColor(flow.volume.vsaBias) }}
            >
              {flow.volume.vsa.replace(/_/g, " ")}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            <StatRow
              label="State"
              value={flow.volume.state}
              tone={flow.volume.spike ? "warn" : "neutral"}
            />
            <StatRow label="Ratio" value={`${fmt(flow.volume.ratio, 2)}×`} />
            <StatRow label="POC" value={fmt(flow.volume.poc, 0)} tone="info" />
            <StatRow label="VAH" value={fmt(flow.volume.vah, 0)} />
            <StatRow label="VAL" value={fmt(flow.volume.val, 0)} />
            <StatRow label="Acceptance" value={(flow.volume.acceptance || "—").replace(/_/g, " ")} />
            <StatRow label="Zone" value={(flow.volume.zone || "—").replace(/_/g, " ")} />
          </div>
        </div>

        {/* Microstructure */}
        {flow.microstructure.available ? (
          <div className="rounded-md border border-white/[0.06] bg-black/20 p-2.5">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/55">
                Microstructure
              </span>
              <span className="font-mono text-[10px] text-white/45">L1-5 Depth</span>
            </div>
            <MeterBar
              value={flow.microstructure.score}
              label="MS Score"
              tone={flow.microstructure.score >= 60 ? "bull" : flow.microstructure.score <= 40 ? "bear" : "neutral"}
            />
            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5">
              <StatRow
                label="Bid/Ask Imb"
                value={fmt(flow.microstructure.bidAskImbalance, 2)}
                tone={flow.microstructure.bidAskImbalance > 0 ? "bull" : "bear"}
              />
              {flow.microstructure.absorption ? (
                <StatRow
                  label="Absorption"
                  value={(flow.microstructure.absorptionSide || "yes").toUpperCase()}
                  tone="info"
                />
              ) : null}
              {flow.microstructure.iceberg ? (
                <StatRow label="Iceberg" value="DETECTED" tone="info" />
              ) : null}
              {flow.microstructure.spoofing ? (
                <StatRow label="Spoofing" value="DETECTED" tone="warn" />
              ) : null}
              {flow.microstructure.liquidityPull ? (
                <StatRow label="Liq Pull" value="DETECTED" tone="warn" />
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
