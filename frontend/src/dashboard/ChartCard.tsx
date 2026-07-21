import "chartjs-adapter-date-fns";

import {
  CategoryScale,
  Chart as ChartJs,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  TimeScale,
  Tooltip,
  type ChartDataset,
  type Plugin,
  type ScatterDataPoint,
} from "chart.js";
import zoomPlugin from "chartjs-plugin-zoom";
import { useEffect, useMemo, useRef, useState } from "react";

import { seriesKey } from "./chart-config";
import { chartCoordinator } from "./chart-coordinator";
import { seriesStats } from "./stats";
import type {
  ChartDefinition,
  CompareMode,
  EventRecord,
  LegendMode,
  LoadedSeries,
  SourceHealth,
  TimeState,
} from "./types";
import { formatAge, formatValue } from "./units";
import { useVisible } from "./use-visible";

ChartJs.register(
  CategoryScale,
  LinearScale,
  TimeScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  Legend,
  Filler,
  zoomPlugin,
);

type Props = {
  chart: ChartDefinition;
  compare: CompareMode;
  events: EventRecord[];
  hiddenSeries: Set<string>;
  inspect: boolean;
  legendMode: LegendMode;
  loading: boolean;
  onInspect: () => void;
  onResetZoom: () => void;
  onSetCompare: (mode: CompareMode) => void;
  onSoloSeries: (chartId: string, key: string) => void;
  onToggleSeries: (key: string) => void;
  onZoom: (start: number, end: number) => void;
  seriesData: Map<string, LoadedSeries>;
  sourceHealth: SourceHealth | null;
  time: TimeState;
};

const cursorByChart = new WeakMap<ChartJs<"line">, number | null>();
const pinnedByChart = new WeakMap<ChartJs<"line">, boolean>();

function downloadCsv(chart: ChartDefinition, data: Map<string, LoadedSeries>) {
  const rows = ["series,timestamp_iso,timestamp_epoch,value"];
  for (const series of chart.series) {
    const loaded = data.get(seriesKey(chart.id, series.id));
    for (const [timestamp, value] of loaded?.points ?? []) {
      rows.push(
        [
          JSON.stringify(series.label),
          new Date(timestamp * 1000).toISOString(),
          timestamp,
          value,
        ].join(","),
      );
    }
  }
  const blob = new Blob([`${rows.join("\n")}\n`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `ercot-${chart.id}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ChartCard({
  chart,
  compare,
  events,
  hiddenSeries,
  inspect,
  legendMode,
  loading,
  onInspect,
  onResetZoom,
  onSetCompare,
  onSoloSeries,
  onToggleSeries,
  onZoom,
  seriesData,
  sourceHealth,
  time,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<ChartJs<"line"> | null>(null);
  const cursorTimestamp = useRef<number | null>(null);
  const pointerDown = useRef<{ x: number; y: number } | null>(null);
  const cursorActive = useRef(false);
  const { mounted, ref: visibilityRef, visible } = useVisible<HTMLElement>();
  const [pinned, setPinned] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    cursorActive.current = visible;
    const instance = chartRef.current;
    if (visible && instance) {
      const snapshot = chartCoordinator.snapshot();
      cursorTimestamp.current = snapshot.timestamp;
      cursorByChart.set(instance, snapshot.timestamp);
      pinnedByChart.set(instance, snapshot.pinned);
      setPinned(snapshot.pinned);
      instance.draw();
    }
  }, [visible]);

  const datasets = useMemo<Array<ChartDataset<"line", ScatterDataPoint[]>>>(() => {
    const output: Array<ChartDataset<"line", ScatterDataPoint[]>> = [];
    for (const series of chart.series) {
      const key = seriesKey(chart.id, series.id);
      const loaded = seriesData.get(key);
      const hidden = hiddenSeries.has(key);
      output.push({
        label: series.label,
        data: (loaded?.points ?? []).map(([timestamp, value]) => ({
          x: timestamp * 1000,
          y: value,
        })),
        borderColor: series.color,
        backgroundColor: series.color,
        borderWidth: 1.6,
        pointRadius: 0,
        pointHitRadius: 12,
        tension: 0,
        spanGaps: false,
        hidden,
      });
      if (compare !== "none" && loaded?.compare.length) {
        output.push({
          label: `${series.label} · ${compare.replace("_", " ")}`,
          data: loaded.compare.map(([timestamp, value]) => ({ x: timestamp * 1000, y: value })),
          borderColor: `${series.color}70`,
          backgroundColor: `${series.color}70`,
          borderWidth: 1.2,
          borderDash: [6, 5],
          pointRadius: 0,
          tension: 0,
          hidden,
        });
      }
    }
    return output;
  }, [chart, compare, hiddenSeries, seriesData]);

  useEffect(() => {
    if (!mounted || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const handlePointerDown = (event: PointerEvent) => {
      pointerDown.current = { x: event.clientX, y: event.clientY };
    };
    const handlePointerUp = (event: PointerEvent) => {
      const start = pointerDown.current;
      pointerDown.current = null;
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
      const instance = chartRef.current;
      if (!instance) return;
      const bounds = canvas.getBoundingClientRect();
      const timestamp = instance.scales["x"].getValueForPixel(event.clientX - bounds.left);
      if (typeof timestamp !== "number") return;
      cursorTimestamp.current = timestamp / 1000;
      chartCoordinator.togglePin(cursorTimestamp.current);
    };
    canvas.addEventListener("pointerdown", handlePointerDown, true);
    canvas.addEventListener("pointerup", handlePointerUp, true);
    const overlayPlugin: Plugin<"line"> = {
      id: `ercot-overlay-${chart.id}`,
      afterDatasetsDraw(instance) {
        const area = instance.chartArea;
        const context = instance.ctx;
        const cursor = cursorByChart.get(instance);
        if (cursor !== null && cursor !== undefined) {
          const x = instance.scales["x"].getPixelForValue(cursor * 1000);
          if (x >= area.left && x <= area.right) {
            context.save();
            context.strokeStyle = pinnedByChart.get(instance)
              ? "rgba(251, 191, 36, 0.95)"
              : "rgba(226, 232, 240, 0.65)";
            context.lineWidth = pinnedByChart.get(instance) ? 2 : 1;
            context.beginPath();
            context.moveTo(x, area.top);
            context.lineTo(x, area.bottom);
            context.stroke();
            context.restore();
          }
        }
        if (events.length) {
          context.save();
          context.strokeStyle = "rgba(248, 113, 113, 0.58)";
          context.setLineDash([3, 3]);
          for (const event of events) {
            const x = instance.scales["x"].getPixelForValue(event.starts_at * 1000);
            if (x < area.left || x > area.right) continue;
            if (event.ends_at) {
              const endX = instance.scales["x"].getPixelForValue(event.ends_at * 1000);
              context.save();
              context.fillStyle = "rgba(248, 113, 113, 0.08)";
              context.fillRect(x, area.top, Math.max(1, endX - x), area.height);
              context.restore();
            }
            context.beginPath();
            context.moveTo(x, area.top);
            context.lineTo(x, area.bottom);
            context.stroke();
          }
          context.restore();
        }
        const partial = chart.series.some(
          (series) => seriesData.get(seriesKey(chart.id, series.id))?.meta.partial_current_bucket,
        );
        if (partial) {
          context.save();
          context.fillStyle = "rgba(148, 163, 184, 0.1)";
          context.fillRect(Math.max(area.left, area.right - 36), area.top, 36, area.height);
          context.restore();
        }
      },
    };
    const instance = new ChartJs(canvasRef.current, {
      type: "line",
      data: { datasets },
      plugins: [overlayPlugin],
      options: {
        animation: false,
        parsing: false,
        normalized: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: "index" },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label(context) {
                const value = context.parsed.y;
                return `${context.dataset.label ?? "Series"}: ${formatValue(value, chart.unit)}`;
              },
            },
          },
          decimation: {
            enabled: true,
            algorithm: chart.spikeCritical ? "min-max" : "lttb",
            samples: 900,
          },
          zoom: {
            limits: { x: { minRange: 5 * 60 * 1000 } },
            pan: {
              enabled: true,
              mode: "x",
              modifierKey: "shift",
              onPanComplete({ chart: panned }) {
                const minimum = panned.scales["x"].min;
                const maximum = panned.scales["x"].max;
                if (Number.isFinite(minimum) && Number.isFinite(maximum)) {
                  onZoom(minimum / 1000, maximum / 1000);
                }
              },
            },
            zoom: {
              mode: "x",
              drag: { enabled: true, backgroundColor: "rgba(96, 165, 250, 0.16)" },
              pinch: { enabled: true },
              wheel: { enabled: true, modifierKey: "ctrl", speed: 0.08 },
              onZoomComplete({ chart: zoomed }) {
                const minimum = zoomed.scales["x"].min;
                const maximum = zoomed.scales["x"].max;
                if (Number.isFinite(minimum) && Number.isFinite(maximum)) {
                  onZoom(minimum / 1000, maximum / 1000);
                }
              },
            },
          },
        },
        scales: {
          x: {
            type: "time",
            min: time.start * 1000,
            max: time.end * 1000,
            time: { tooltipFormat: "MMM d, yyyy HH:mm:ss" },
            ticks: { color: "#94a3b8", maxRotation: 0, sampleSize: 8 },
            grid: { color: "rgba(148, 163, 184, 0.08)" },
          },
          y: {
            ticks: {
              color: "#94a3b8",
              callback: (value) => formatValue(Number(value), chart.unit, true),
            },
            grid: { color: "rgba(148, 163, 184, 0.08)" },
          },
        },
      },
    });
    chartRef.current = instance;
    const initialCursor = chartCoordinator.snapshot();
    cursorTimestamp.current = initialCursor.timestamp;
    cursorByChart.set(instance, initialCursor.timestamp);
    pinnedByChart.set(instance, initialCursor.pinned);
    setPinned(initialCursor.pinned);
    const unsubscribe = chartCoordinator.subscribe((timestamp, isPinned) => {
      if (!cursorActive.current) return;
      cursorTimestamp.current = timestamp;
      cursorByChart.set(instance, timestamp);
      pinnedByChart.set(instance, isPinned);
      setPinned(isPinned);
      instance.draw();
    });
    return () => {
      unsubscribe();
      canvas.removeEventListener("pointerdown", handlePointerDown, true);
      canvas.removeEventListener("pointerup", handlePointerUp, true);
      cursorByChart.delete(instance);
      pinnedByChart.delete(instance);
      instance.destroy();
      chartRef.current = null;
    };
  }, [chart, datasets, events, mounted, onZoom, seriesData, time.end, time.start]);

  const allPoints = chart.series.flatMap(
    (series) => seriesData.get(seriesKey(chart.id, series.id))?.points ?? [],
  );
  const errors = chart.series
    .map((series) => seriesData.get(seriesKey(chart.id, series.id))?.error)
    .filter((value): value is string => Boolean(value));
  const partial = chart.series.some(
    (series) => seriesData.get(seriesKey(chart.id, series.id))?.meta.partial_current_bucket,
  );
  const stale = sourceHealth?.state === "stale" || sourceHealth?.state === "failed";

  return (
    <article
      className={`chart-card ${inspect ? "chart-card-inspect" : ""}`}
      data-chart-id={chart.id}
      data-mounted={mounted ? "true" : "false"}
      data-visible={visible ? "true" : "false"}
      ref={visibilityRef}
    >
      <header className="chart-card-header">
        <div>
          <p className="eyebrow">{chart.group}</p>
          <h3>{chart.title}</h3>
          <p className="chart-description">{chart.description}</p>
        </div>
        <div className="chart-actions">
          <button
            aria-label={`${inspect ? "Close" : "Open"} ${chart.title} inspect mode`}
            onClick={onInspect}
          >
            {inspect ? "Close" : "Inspect"}
          </button>
          <details>
            <summary aria-label={`${chart.title} chart menu`}>•••</summary>
            <div className="chart-menu" role="menu">
              <button onClick={onInspect} role="menuitem">
                {inspect ? "Close inspect" : "Open inspect"}
              </button>
              <button
                onClick={() => onSetCompare(compare === "none" ? "previous_period" : "none")}
                role="menuitem"
              >
                {compare === "none" ? "Enable comparison" : "Disable comparison"}
              </button>
              <button
                onClick={() => {
                  chartRef.current?.resetZoom();
                  onResetZoom();
                }}
                role="menuitem"
              >
                Reset zoom
              </button>
              <button onClick={() => downloadCsv(chart, seriesData)} role="menuitem">
                Download CSV
              </button>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(window.location.href).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  });
                }}
                role="menuitem"
              >
                {copied ? "Link copied" : "Copy link"}
              </button>
              <a href={chart.sourceUrl} rel="noreferrer" role="menuitem" target="_blank">
                ERCOT source
              </a>
            </div>
          </details>
        </div>
      </header>

      <div className="chart-status-row" aria-live="polite">
        {sourceHealth ? (
          <span className={`status-chip status-${sourceHealth.state}`}>
            {sourceHealth.state} · {formatAge(sourceHealth.age_seconds)}
          </span>
        ) : null}
        {partial ? <span className="status-chip status-partial">partial bucket</span> : null}
        {pinned ? <span className="status-chip status-pinned">cursor pinned</span> : null}
      </div>

      <div
        className="chart-canvas-wrap"
        onKeyDown={(event) => {
          if (event.key === "Escape") chartCoordinator.clearPin();
        }}
        onMouseLeave={() => chartCoordinator.publish(null)}
        onMouseMove={(event) => {
          const instance = chartRef.current;
          if (!instance) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const pixel = event.clientX - bounds.left;
          const timestamp = instance.scales["x"].getValueForPixel(pixel);
          if (typeof timestamp === "number") {
            cursorTimestamp.current = timestamp / 1000;
            chartCoordinator.publish(timestamp / 1000);
          }
        }}
        role="presentation"
      >
        {!mounted || loading ? <div className="chart-placeholder">Loading chart…</div> : null}
        {!loading && errors.length ? (
          <div className="chart-overlay chart-error">Source request failed: {errors[0]}</div>
        ) : null}
        {!loading && !errors.length && !allPoints.length ? (
          <div className="chart-overlay chart-empty">No observations in this window.</div>
        ) : null}
        {stale && allPoints.length ? (
          <div className="chart-overlay chart-stale">Showing stale data</div>
        ) : null}
        <canvas
          aria-label={`${chart.title}. ${allPoints.length} observations. Use the legend or CSV menu for exact values.`}
          ref={canvasRef}
          role="img"
        />
      </div>

      <div className={`series-legend legend-${legendMode}`}>
        {chart.series.map((series) => {
          const key = seriesKey(chart.id, series.id);
          const loaded = seriesData.get(key);
          const stats = seriesStats(loaded?.points ?? []);
          const hidden = hiddenSeries.has(key);
          return (
            <div className={`legend-row ${hidden ? "legend-row-hidden" : ""}`} key={key}>
              <button
                aria-pressed={!hidden}
                className="legend-toggle"
                onClick={() => onToggleSeries(key)}
                style={{ "--series-color": series.color } as React.CSSProperties}
              >
                <span className="legend-swatch" />
                {series.label}
              </button>
              <span className="legend-latest">{formatValue(stats.latest, chart.unit)}</span>
              <button
                aria-label={`Solo ${series.label}`}
                className="legend-solo"
                onClick={() => onSoloSeries(chart.id, key)}
              >
                Solo
              </button>
              {legendMode === "expanded" ? (
                <span className="legend-stats">
                  min {formatValue(stats.minimum, chart.unit)} · max{" "}
                  {formatValue(stats.maximum, chart.unit)} · avg{" "}
                  {formatValue(stats.average, chart.unit)} · sum{" "}
                  {formatValue(stats.sum, chart.unit)}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      <details className="accessible-data">
        <summary>Accessible data table</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Series</th>
                <th>Timestamp</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {chart.series.flatMap((series) =>
                (seriesData.get(seriesKey(chart.id, series.id))?.points ?? [])
                  .slice(-250)
                  .map(([timestamp, value]) => (
                    <tr key={`${series.id}:${timestamp}`}>
                      <td>{series.label}</td>
                      <td>{new Date(timestamp * 1000).toISOString()}</td>
                      <td>{formatValue(value, chart.unit)}</td>
                    </tr>
                  )),
              )}
            </tbody>
          </table>
        </div>
      </details>
    </article>
  );
}
