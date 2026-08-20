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

import { DataLifecycleMessage } from "../components/DataLifecycleMessage";
import { seriesKey } from "./chart-config";
import {
  formatInterpretationRange,
  interpretationAriaDescription,
  resolveInterpretationBands,
} from "./chart-interpretation";
import { chartCoordinator } from "./chart-coordinator";
import { chartInteractionPolicy } from "./interaction-policy";
import { resolveDataLifecycleState } from "./data-lifecycle";
import { seriesStats } from "./stats";
import { StorageOperationsSummary } from "./StorageOperationsSummary";
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
  mobile: boolean;
  onInspect: () => void;
  onResetZoom: () => void;
  onSetCompare: (mode: CompareMode) => void;
  onSoloSeries: (chartId: string, key: string) => void;
  onToggleSeries: (key: string) => void;
  onVisibilityChange: (chartId: string, visible: boolean) => void;
  onZoom: (start: number, end: number) => void;
  presentation?: "featured" | "standard";
  requestError: string | null;
  seriesData: Map<string, LoadedSeries>;
  sourceHealth: SourceHealth | null;
  time: TimeState;
};

const cursorByChart = new WeakMap<ChartJs<"line">, number | null>();
const pinnedByChart = new WeakMap<ChartJs<"line">, boolean>();
const interpretationFill = {
  critical: "rgba(248, 113, 113, 0.1)",
  informational: "rgba(96, 165, 250, 0.08)",
  normal: "rgba(52, 211, 153, 0.07)",
  strained: "rgba(251, 146, 60, 0.09)",
  watch: "rgba(251, 191, 36, 0.08)",
} as const;

function downloadCsv(chart: ChartDefinition, data: Map<string, LoadedSeries>) {
  const rows = ["series,timestamp_iso,timestamp_epoch,value"];
  for (const series of chart.series.filter((candidate) => !candidate.inputOnly)) {
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
  mobile,
  onInspect,
  onResetZoom,
  onSetCompare,
  onSoloSeries,
  onToggleSeries,
  onVisibilityChange,
  onZoom,
  presentation = "standard",
  requestError,
  seriesData,
  sourceHealth,
  time,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<ChartJs<"line"> | null>(null);
  const accessibleDataRef = useRef<HTMLDetailsElement>(null);
  const inspectTriggerRef = useRef<HTMLButtonElement>(null);
  const cursorTimestamp = useRef<number | null>(null);
  const pointerDown = useRef<{ x: number; y: number } | null>(null);
  const cursorActive = useRef(false);
  const interactionPolicy = useMemo(
    () => chartInteractionPolicy({ inspect, mobile }),
    [inspect, mobile],
  );
  const {
    mounted,
    ref: visibilityRef,
    visible,
  } = useVisible<HTMLElement>(mobile ? "0px" : "100px");
  const [pinned, setPinned] = useState(false);
  const [copied, setCopied] = useState(false);
  const [interpretationOpen, setInterpretationOpen] = useState(!mobile);
  const interpretation = chart.interpretation;
  const interpretationDescription = interpretationAriaDescription(chart);
  const resolvedInterpretation = interpretation
    ? resolveInterpretationBands(interpretation, seriesData)
    : [];
  const visibleSeries = useMemo(
    () => chart.series.filter((series) => !series.inputOnly),
    [chart.series],
  );

  useEffect(() => {
    cursorActive.current = visible && interactionPolicy.cursorPin;
    const instance = chartRef.current;
    if (visible && instance) {
      const snapshot = chartCoordinator.snapshot();
      cursorTimestamp.current = snapshot.timestamp;
      cursorByChart.set(instance, snapshot.timestamp);
      pinnedByChart.set(instance, snapshot.pinned);
      setPinned(snapshot.pinned);
      instance.draw();
    }
  }, [interactionPolicy.cursorPin, visible]);

  const wasInspect = useRef(false);
  useEffect(() => {
    if (wasInspect.current && !inspect) {
      window.requestAnimationFrame(() => inspectTriggerRef.current?.focus());
    }
    wasInspect.current = inspect;
  }, [inspect]);

  useEffect(() => {
    onVisibilityChange(chart.id, visible);
    return () => onVisibilityChange(chart.id, false);
  }, [chart.id, onVisibilityChange, visible]);

  const datasets = useMemo<Array<ChartDataset<"line", ScatterDataPoint[]>>>(() => {
    const output: Array<ChartDataset<"line", ScatterDataPoint[]>> = [];
    for (const series of visibleSeries) {
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
        ...(series.lineStyle === "dashed" ? { borderDash: [5, 4] } : {}),
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
  }, [chart, compare, hiddenSeries, seriesData, visibleSeries]);
  const hasData = visibleSeries.some(
    (series) => (seriesData.get(seriesKey(chart.id, series.id))?.points.length ?? 0) > 0,
  );

  const dynamic = useRef({ datasets, events, interactionPolicy, onZoom, seriesData, time });
  dynamic.current = { datasets, events, interactionPolicy, onZoom, seriesData, time };

  useEffect(() => {
    if (!hasData || !mounted || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const handlePointerDown = (event: PointerEvent) => {
      if (!dynamic.current.interactionPolicy.cursorPin) return;
      pointerDown.current = { x: event.clientX, y: event.clientY };
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (!dynamic.current.interactionPolicy.cursorPin) return;
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
      beforeDatasetsDraw(instance) {
        if (!chart.interpretation) return;
        const area = instance.chartArea;
        const context = instance.ctx;
        const yScale = instance.scales["y"];
        if (!yScale) return;
        const bands = resolveInterpretationBands(chart.interpretation, dynamic.current.seriesData);
        context.save();
        for (const band of bands) {
          const upper =
            band.upperValue === undefined ? area.top : yScale.getPixelForValue(band.upperValue);
          const lower =
            band.lowerValue === undefined ? area.bottom : yScale.getPixelForValue(band.lowerValue);
          const top = Math.max(area.top, Math.min(area.bottom, Math.min(upper, lower)));
          const bottom = Math.max(area.top, Math.min(area.bottom, Math.max(upper, lower)));
          if (bottom <= top) continue;
          context.fillStyle = interpretationFill[band.tone];
          context.fillRect(area.left, top, area.width, bottom - top);
        }
        context.restore();
      },
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
        if (dynamic.current.events.length) {
          context.save();
          context.strokeStyle = "rgba(248, 113, 113, 0.58)";
          context.setLineDash([3, 3]);
          for (const event of dynamic.current.events) {
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
        const partial = visibleSeries.some(
          (series) =>
            dynamic.current.seriesData.get(seriesKey(chart.id, series.id))?.meta
              .partial_current_bucket,
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
      data: { datasets: dynamic.current.datasets },
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
              enabled: dynamic.current.interactionPolicy.pan,
              mode: "x",
              modifierKey: dynamic.current.interactionPolicy.panModifier,
              onPanComplete({ chart: panned }) {
                const minimum = panned.scales["x"].min;
                const maximum = panned.scales["x"].max;
                if (Number.isFinite(minimum) && Number.isFinite(maximum)) {
                  dynamic.current.onZoom(minimum / 1000, maximum / 1000);
                }
              },
            },
            zoom: {
              mode: "x",
              drag: {
                enabled: dynamic.current.interactionPolicy.dragZoom,
                backgroundColor: "rgba(96, 165, 250, 0.16)",
              },
              pinch: { enabled: dynamic.current.interactionPolicy.pinchZoom },
              wheel: {
                enabled: dynamic.current.interactionPolicy.wheelZoom,
                modifierKey: "ctrl",
                speed: 0.08,
              },
              onZoomComplete({ chart: zoomed }) {
                const minimum = zoomed.scales["x"].min;
                const maximum = zoomed.scales["x"].max;
                if (Number.isFinite(minimum) && Number.isFinite(maximum)) {
                  dynamic.current.onZoom(minimum / 1000, maximum / 1000);
                }
              },
            },
          },
        },
        scales: {
          x: {
            type: "time",
            min: dynamic.current.time.start * 1000,
            max: dynamic.current.time.end * 1000,
            time: { tooltipFormat: "MMM d, yyyy HH:mm:ss" },
            ticks: { color: "#94a3b8", maxRotation: 0, sampleSize: 8 },
            grid: { color: "rgba(148, 163, 184, 0.08)" },
          },
          y: {
            ...(chart.zeroCentered
              ? {
                  suggestedMin:
                    -Math.max(
                      0,
                      ...datasets.flatMap((dataset) =>
                        dataset.data.map((point) => Math.abs(point.y ?? 0)),
                      ),
                    ) || -1,
                  suggestedMax:
                    Math.max(
                      0,
                      ...datasets.flatMap((dataset) =>
                        dataset.data.map((point) => Math.abs(point.y ?? 0)),
                      ),
                    ) || 1,
                }
              : {}),
            ticks: {
              color: "#94a3b8",
              callback: (value) => formatValue(Number(value), chart.unit),
            },
            grid: { color: "rgba(148, 163, 184, 0.08)" },
          },
        },
      },
    });
    window.__ercotChartLifecycle ??= { constructed: 0, destroyed: 0, updated: 0 };
    window.__ercotChartLifecycle.constructed += 1;
    chartRef.current = instance;
    canvas.dataset["chartReady"] = dynamic.current.datasets.some((dataset) => dataset.data.length)
      ? "true"
      : "false";
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
      window.__ercotChartLifecycle!.destroyed += 1;
      chartRef.current = null;
      delete canvas.dataset["chartReady"];
    };
  }, [chart, hasData, mounted]);

  useEffect(() => {
    const instance = chartRef.current;
    const zoomOptions = instance?.options.plugins?.zoom;
    if (!instance || !zoomOptions) return;
    zoomOptions.pan = {
      ...zoomOptions.pan,
      enabled: interactionPolicy.pan,
      modifierKey: interactionPolicy.panModifier,
    };
    zoomOptions.zoom = {
      ...zoomOptions.zoom,
      drag: {
        ...zoomOptions.zoom?.drag,
        enabled: interactionPolicy.dragZoom,
      },
      pinch: {
        ...zoomOptions.zoom?.pinch,
        enabled: interactionPolicy.pinchZoom,
      },
      wheel: {
        ...zoomOptions.zoom?.wheel,
        enabled: interactionPolicy.wheelZoom,
      },
    };
    instance.update("none");
  }, [interactionPolicy]);

  useEffect(() => {
    const instance = chartRef.current;
    if (!instance) return;
    instance.data.datasets = datasets;
    const xScale = instance.options.scales?.["x"];
    if (xScale) {
      xScale.min = time.start * 1000;
      xScale.max = time.end * 1000;
    }
    instance.update("none");
    instance.canvas.dataset["chartReady"] = datasets.some((dataset) => dataset.data.length)
      ? "true"
      : "false";
    window.__ercotChartLifecycle ??= { constructed: 0, destroyed: 0, updated: 0 };
    window.__ercotChartLifecycle.updated += 1;
  }, [datasets, events, seriesData, time.end, time.start]);

  const allPoints = visibleSeries.flatMap(
    (series) => seriesData.get(seriesKey(chart.id, series.id))?.points ?? [],
  );
  const errors = chart.series
    .map((series) => seriesData.get(seriesKey(chart.id, series.id))?.error)
    .filter((value): value is string => Boolean(value));
  const updateUnavailable = !loading && Boolean(errors.length || requestError);
  const sourceUnavailable =
    !hasData && (sourceHealth?.state === "failed" || sourceHealth?.state === "stale");
  const lifecycleState = !mounted
    ? "loading"
    : resolveDataLifecycleState({
        hasData,
        loading,
        unavailable: updateUnavailable || sourceUnavailable,
      });
  const sourceLifecycleDetail = sourceUnavailable
    ? `${sourceHealth?.collection_state === "failed" ? "Collection failed" : "Source is stale"}${
        sourceHealth?.data_age_seconds === null
          ? " and no valid observation is available."
          : ` · last valid observation ${formatAge(sourceHealth?.data_age_seconds ?? null)}.`
      }`
    : undefined;
  const partial = visibleSeries.some(
    (series) => seriesData.get(seriesKey(chart.id, series.id))?.meta.partial_current_bucket,
  );
  const stale = sourceHealth?.state === "stale" || sourceHealth?.state === "failed";
  const showStatusRow = Boolean(
    (sourceHealth && sourceHealth.state !== "healthy") || (partial && hasData) || pinned,
  );
  const resetChartZoom = () => {
    chartRef.current?.resetZoom();
    onResetZoom();
  };
  const showDataTable = () => {
    if (!accessibleDataRef.current) return;
    accessibleDataRef.current.open = true;
    accessibleDataRef.current.querySelector("summary")?.focus();
  };

  return (
    <article
      aria-label={inspect ? "Inspect " + chart.title : undefined}
      aria-modal={inspect ? "true" : undefined}
      className={`chart-card ${presentation === "featured" ? "chart-card-featured" : ""} ${inspect ? "chart-card-inspect" : ""}`}
      data-chart-id={chart.id}
      data-interaction-policy={interactionPolicy.policyName}
      data-lifecycle-state={lifecycleState}
      data-mounted={mounted ? "true" : "false"}
      data-visible={visible ? "true" : "false"}
      onKeyDown={(event) => {
        if (!inspect) return;
        if (event.key === "Escape") {
          event.preventDefault();
          chartCoordinator.clearPin();
          onInspect();
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex='-1'])",
          ),
        ];
        const first = focusable.at(0);
        const last = focusable.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      ref={visibilityRef}
      role={inspect ? "dialog" : undefined}
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
            ref={inspectTriggerRef}
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
              <button
                disabled={!hasData}
                onClick={() => downloadCsv(chart, seriesData)}
                role="menuitem"
              >
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

      {inspect ? (
        <div
          aria-label={chart.title + " inspect actions"}
          className="inspect-toolbar"
          role="toolbar"
        >
          <button aria-label="Close inspect" onClick={onInspect}>
            Close
          </button>
          <button aria-label="Reset zoom" onClick={resetChartZoom}>
            Reset zoom
          </button>
          <button
            aria-label={compare === "none" ? "Enable comparison" : "Disable comparison"}
            onClick={() => onSetCompare(compare === "none" ? "previous_period" : "none")}
          >
            {compare === "none" ? "Compare" : "No compare"}
          </button>
          <button
            aria-label="Download CSV"
            disabled={!hasData}
            onClick={() => downloadCsv(chart, seriesData)}
          >
            CSV
          </button>
          <a aria-label="ERCOT source" href={chart.sourceUrl} rel="noreferrer" target="_blank">
            Source
          </a>
          <button aria-label="Show data table" disabled={!hasData} onClick={showDataTable}>
            Data
          </button>
        </div>
      ) : null}

      {showStatusRow ? (
        <div className="chart-status-row" aria-live="polite">
          {sourceHealth && sourceHealth.state !== "healthy" ? (
            <span className={`status-chip status-${sourceHealth.state}`}>
              Data {sourceHealth.freshness_state} · {formatAge(sourceHealth.data_age_seconds)}
            </span>
          ) : null}
          {partial && hasData ? (
            <span className="status-chip status-partial">partial bucket</span>
          ) : null}
          {pinned ? <span className="status-chip status-pinned">cursor pinned</span> : null}
        </div>
      ) : null}

      {chart.id === "storage" ? (
        <StorageOperationsSummary seriesData={seriesData} sourceHealth={sourceHealth} time={time} />
      ) : null}

      {inspect && mobile ? (
        <p className="inspect-gesture-hint">
          Pinch to zoom · drag horizontally to pan · tap to pin the cursor
        </p>
      ) : null}

      {interpretation && hasData && (presentation === "standard" || inspect) ? (
        <details
          className="chart-interpretation"
          onToggle={(event) => setInterpretationOpen(event.currentTarget.open)}
          open={interpretationOpen}
        >
          <summary>
            Interpretation guide · <strong>{interpretation.subject}</strong>
          </summary>
          <p>{interpretation.basis}.</p>
          {interpretation.mode === "reference-ratio" && !resolvedInterpretation.length ? (
            <p className="interpretation-reference-unavailable">
              Waiting for {interpretation.referenceLabel} to draw the canvas bands.
            </p>
          ) : null}
          <ul aria-label={`${chart.title} interpretation bands`}>
            {interpretation.bands.map((band) => (
              <li className={`interpretation-${band.tone}`} key={band.id}>
                <span aria-hidden="true" className="interpretation-swatch" />
                <strong>{band.label}</strong>
                <span>{formatInterpretationRange(interpretation, band, chart.unit)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {lifecycleState === "ready" ? (
        <div
          className="chart-canvas-wrap"
          data-lifecycle-state={lifecycleState}
          onKeyDown={(event) => {
            if (event.key === "Escape") chartCoordinator.clearPin();
          }}
          onMouseLeave={() => chartCoordinator.publish(null)}
          onMouseMove={(event) => {
            if (!interactionPolicy.cursorPin) return;
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
          {updateUnavailable ? (
            <div className="chart-overlay chart-error">
              Temporarily unavailable… Existing observations remain visible.
            </div>
          ) : null}
          {stale ? <div className="chart-overlay chart-stale">Showing stale data</div> : null}
          <canvas
            aria-label={`${chart.title}. ${allPoints.length} observations. ${interpretationDescription} Use the legend or CSV menu for exact values.`}
            ref={canvasRef}
            role="img"
          />
        </div>
      ) : (
        <div className="chart-canvas-wrap" data-lifecycle-state={lifecycleState}>
          <div className="chart-overlay chart-lifecycle-overlay">
            <DataLifecycleMessage
              detail={sourceLifecycleDetail}
              state={lifecycleState}
              title={sourceUnavailable ? `${chart.title} unavailable` : undefined}
            />
          </div>
        </div>
      )}

      {hasData ? (
        <div
          className={`series-legend legend-${presentation === "featured" && !inspect ? "compact" : legendMode}`}
        >
          {visibleSeries.map((series) => {
            const key = seriesKey(chart.id, series.id);
            const loaded = seriesData.get(key);
            const sampledStats = seriesStats(loaded?.points ?? []);
            const stats = loaded?.meta.stats ?? {
              average: sampledStats.average,
              count: loaded?.points.length ?? 0,
              energy_mwh: null,
              latest: sampledStats.latest,
              maximum: sampledStats.maximum,
              minimum: sampledStats.minimum,
            };
            const hidden = hiddenSeries.has(key);
            return (
              <div className={`legend-row ${hidden ? "legend-row-hidden" : ""}`} key={key}>
                <button
                  aria-pressed={!hidden}
                  className="legend-toggle"
                  onClick={() => onToggleSeries(key)}
                  style={{ "--series-color": series.color } as React.CSSProperties}
                >
                  <span
                    className={`legend-swatch ${series.lineStyle === "dashed" ? "legend-swatch-dashed" : ""}`}
                  />
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
                {(presentation === "standard" || inspect) && legendMode === "expanded" ? (
                  <span className="legend-stats">
                    min {formatValue(stats.minimum, chart.unit)} · max{" "}
                    {formatValue(stats.maximum, chart.unit)} · avg{" "}
                    {formatValue(stats.average, chart.unit)}
                    {chart.statisticPolicy === "power" && stats.energy_mwh !== null
                      ? ` · energy ${formatValue(stats.energy_mwh, "MWh")}`
                      : ""}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {hasData ? (
        <details className="accessible-data" ref={accessibleDataRef}>
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
                {visibleSeries.flatMap((series) =>
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
      ) : null}
    </article>
  );
}
