import { useEffect, useRef } from "react";
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  CrosshairMode,
} from "lightweight-charts";
import type { IntelSnapshot } from "@/lib/intelTypes";
import { Panel } from "./Panel";

function toCandleData(
  candles: IntelSnapshot["chart"]["candles1m"],
): CandlestickData[] {
  return candles
    .filter((c) => Number.isFinite(c.t))
    .map((c) => ({
      time: (c.t > 1e10 ? Math.floor(c.t / 1000) : c.t) as CandlestickData["time"],
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
    }));
}

export function MiniChart({ data }: { data: IntelSnapshot | null }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const vwapRef = useRef<ISeriesApi<"Line"> | null>(null);
  const ema9Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const ema20Ref = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor: "#9ca3af",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.03)" },
        horzLines: { color: "rgba(255,255,255,0.03)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true, secondsVisible: false },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    });
    chartRef.current = chart;
    candleSeriesRef.current = chart.addCandlestickSeries({
      upColor: "#10b981",
      downColor: "#ef4444",
      wickUpColor: "#10b981",
      wickDownColor: "#ef4444",
      borderVisible: false,
    });
    vwapRef.current = chart.addLineSeries({
      color: "#a855f7",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    ema9Ref.current = chart.addLineSeries({
      color: "#3b82f6",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    ema20Ref.current = chart.addLineSeries({
      color: "#f59e0b",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    const ro = new ResizeObserver(() => {
      if (!containerRef.current || !chartRef.current) return;
      chartRef.current.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });
    });
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  // Update candles
  useEffect(() => {
    if (!candleSeriesRef.current || !data?.chart?.candles1m?.length) return;
    const candles = toCandleData(data.chart.candles1m);
    candleSeriesRef.current.setData(candles);

    // VWAP / EMA as flat reference lines (we get one value, render as flat line over visible range)
    if (candles.length && vwapRef.current && data.spot.vwap > 0) {
      const start = candles[0].time;
      const end = candles[candles.length - 1].time;
      vwapRef.current.setData([
        { time: start, value: data.spot.vwap },
        { time: end, value: data.spot.vwap },
      ]);
    }
    if (candles.length && ema9Ref.current && data.spot.ema9 > 0) {
      const start = candles[0].time;
      const end = candles[candles.length - 1].time;
      ema9Ref.current.setData([
        { time: start, value: data.spot.ema9 },
        { time: end, value: data.spot.ema9 },
      ]);
    }
    if (candles.length && ema20Ref.current && data.spot.ema20 > 0) {
      const start = candles[0].time;
      const end = candles[candles.length - 1].time;
      ema20Ref.current.setData([
        { time: start, value: data.spot.ema20 },
        { time: end, value: data.spot.ema20 },
      ]);
    }

    // Auto-fit
    chartRef.current?.timeScale().fitContent();
  }, [data]);

  return (
    <Panel
      title={`${data?.displayName || "Spot"} · 1m`}
      badge={
        <div className="flex items-center gap-3 text-[10px]">
          <span className="text-purple-400">VWAP {data?.spot.vwap?.toFixed(2) || "—"}</span>
          <span className="text-blue-400">EMA9 {data?.spot.ema9?.toFixed(2) || "—"}</span>
          <span className="text-amber-400">EMA20 {data?.spot.ema20?.toFixed(2) || "—"}</span>
        </div>
      }
      className="h-full min-h-[260px]"
    >
      <div className="flex h-full flex-col">
        <div ref={containerRef} className="flex-1" />
        {data ? (
          <div className="mt-2 grid grid-cols-3 gap-2 border-t border-white/[0.06] pt-2 text-[10px] sm:grid-cols-6">
            <Stat label="Day H" value={data.spot.dayHigh.toFixed(2)} tone="bull" />
            <Stat label="Day L" value={data.spot.dayLow.toFixed(2)} tone="bear" />
            <Stat label="PDH" value={data.spot.pdh.toFixed(2)} />
            <Stat label="PDL" value={data.spot.pdl.toFixed(2)} />
            <Stat
              label="OR-H"
              value={data.spot.openingRangeHigh.toFixed(2)}
              tone="info"
            />
            <Stat
              label="OR-L"
              value={data.spot.openingRangeLow.toFixed(2)}
              tone="info"
            />
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "bull" | "bear" | "info";
}) {
  const color =
    tone === "bull"
      ? "text-emerald-400"
      : tone === "bear"
        ? "text-rose-400"
        : tone === "info"
          ? "text-sky-400"
          : "text-white/70";
  return (
    <div className="flex items-center justify-between gap-1">
      <span className="text-white/35">{label}</span>
      <span className={`font-mono tabular-nums ${color}`}>{value}</span>
    </div>
  );
}
