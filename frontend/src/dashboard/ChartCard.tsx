import { observationAt, seriesResolution, temporalPolicy } from "./series-temporal-policy";
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
import { alignedGeneration, displayPoints, seriesGapSeconds, marketTime } from "./homepage-model";
import {
  formatInterpretationRange,
  interpretationAriaDescription,
  frequencyColor,
  resolveInterpretationBands,
} from "./chart-interpretation";
import { chartCoordinator } from "./chart-coordinator";
import { chartGroupDisplayLabel } from "./information-architecture";
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
  onVisibilityChange: (chartId: string, visible: boolean) => void;
  onZoom: (start: number, end: number) => void;
  presentation?: "featured" | "standard" | "overview";
  requestError: string | null;
  seriesData: Map<string, LoadedSeries>;
  sourceHealth: SourceHealth | null;
  time: TimeState;
};

const cursorByChart = new WeakMap<ChartJs<"line">, number | null>();
function CursorLegendValue({
  loaded,
  latest,
  unit,
  visible,
  policy,
}: {
  loaded: LoadedSeries | undefined;
  latest: number | null;
  unit: string;
  visible: boolean;
  policy: import("./types").SeriesTemporalPolicy | undefined;
}) {
  const [cursor, setCursor] = useState(chartCoordinator.snapshot().timestamp);
  useEffect(() => {
    if (!visible) return;
    setCursor(chartCoordinator.snapshot().timestamp);
    const unsubscribe = chartCoordinator.subscribe((timestamp) => setCursor(timestamp));
    return () => {
      unsubscribe();
    };
  }, [visible]);
  const sample = cursor === null ? null : observationAt(loaded, cursor, policy);
  return (
    <span
      className="legend-latest"
      data-value-scope={cursor === null ? "window-latest" : "cursor"}
      title={
        cursor === null
          ? "Latest value in selected window"
          : sample
            ? `${marketTime(sample.ts)} · ${Math.round(cursor - sample.ts)}s before cursor · ${sample.resolution === "native" ? "source observation" : `${sample.resolution} resolution · ${sample.coverage} coverage`}`
            : "No recent preceding observation"
      }
    >
      {formatValue(cursor === null ? latest : (sample?.value ?? null), unit)}
      {sample && sample.resolution !== "native" ? "*" : ""}
    </span>
  );
}
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
  onVisibilityChange,
  onZoom,
  presentation = "standard",
  requestError,
  seriesData,
  sourceHealth,
  time,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorLineRef = useRef<HTMLDivElement>(null);
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
    const stacked = chart.id === "fuel-mix" && presentation === "overview";
    const aligned = stacked
      ? alignedGeneration(
          visibleSeries.map(
            (series) =>
              seriesData.get(seriesKey(chart.id, series.id)) ?? {
                points: [],
                compare: [],
                meta: {},
                error: null,
              },
          ),
        )
      : [];
    for (const series of visibleSeries) {
      const key = seriesKey(chart.id, series.id);
      const loaded = seriesData.get(key);
      const hidden = hiddenSeries.has(key);
      output.push({
        label: series.label,
        data: stacked
          ? aligned[visibleSeries.indexOf(series)]
          : displayPoints(
              loaded?.points ?? [],
              seriesGapSeconds(chart.id, series, loaded),
              loaded?.meta.observed_envelope_support,
            ),
        borderColor: series.color,
        ...(seriesResolution(loaded, temporalPolicy(chart.id, series)) !== "native"
          ? { borderDash: [4, 4] }
          : {}),
        backgroundColor: stacked ? `${series.color}a0` : series.color,
        ...(stacked ? { fill: true, stack: "generation" } : {}),
        ...(chart.id === "storage" && presentation === "overview" && series.id !== "net-output"
          ? { fill: "origin", backgroundColor: `${series.color}50` }
          : {}),
        ...(chart.id === "frequency"
          ? {
              segment: {
                borderColor: (context) => frequencyColor(chart, context.p1.parsed.y, series.color),
              },
            }
          : {}),
        ...(series.lineStyle === "dashed" ? { borderDash: [5, 4] } : {}),
        borderWidth: 1.6,
        pointRadius: seriesGapSeconds(chart.id, series, loaded) === 0 ? 3 : 0,
        pointHitRadius: 12,
        tension: 0,
        ...(chart.id === "eea" ? { stepped: "after" as const } : {}),
        spanGaps: false,
        hidden,
      });
      if (compare !== "none" && loaded?.compare.length) {
        output.push({
          label: `${series.label} · ${compare.replace("_", " ")}`,
          data: displayPoints(
            loaded.compare,
            seriesGapSeconds(chart.id, series, loaded),
            loaded.meta.comparison_observed_envelope_support,
          ),
          stack: `comparison-${series.id}`,
          fill: false,
          borderColor: `${series.color}70`,
          backgroundColor: `${series.color}70`,
          borderWidth: 1.2,
          borderDash: [6, 5],
          pointRadius: seriesGapSeconds(chart.id, series, loaded) === 0 ? 3 : 0,
          tension: 0,
          ...(chart.id === "eea" ? { stepped: "after" as const } : {}),
          hidden,
        });
      }
    }
    return output;
  }, [chart, compare, hiddenSeries, seriesData, visibleSeries, presentation]);
  const hasData = visibleSeries.some(
    (series) => (seriesData.get(seriesKey(chart.id, series.id))?.points.length ?? 0) > 0,
  );

  const dynamic = useRef({ datasets, events, interactionPolicy, onZoom, seriesData, time });
  const suppressZoomCommit = useRef(false);
  dynamic.current = { datasets, events, interactionPolicy, onZoom, seriesData, time };

  useEffect(() => {
    if (!hasData || !mounted || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const paintCursor = (
      instance: ChartJs<"line">,
      timestamp: number | null,
      isPinned: boolean,
    ) => {
      const line = cursorLineRef.current;
      if (!line) return;
      const area = instance.chartArea;
      const x =
        timestamp === null ? Number.NaN : instance.scales["x"].getPixelForValue(timestamp * 1000);
      line.style.display =
        Number.isFinite(x) && x >= area.left && x <= area.right ? "block" : "none";
      line.style.left = `${x}px`;
      line.style.top = `${area.top}px`;
      line.style.height = `${area.height}px`;
      line.style.background = isPinned ? "#fbbf24" : "#cbd5e1";
    };
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
        if (
          !chart.interpretation ||
          chart.interpretation.mode === "reference-ratio" ||
          presentation === "overview"
        )
          return;
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
        if (chart.id === "frequency" || chart.zeroCentered) {
          const y = instance.scales["y"].getPixelForValue(chart.id === "frequency" ? 60 : 0);
          context.save();
          context.strokeStyle = "#aebdd0";
          context.setLineDash([4, 4]);
          context.beginPath();
          context.moveTo(area.left, y);
          context.lineTo(area.right, y);
          context.stroke();
          context.restore();
        }
        const cursor = cursorByChart.get(instance);
        if (presentation === "overview")
          paintCursor(instance, cursor ?? null, pinnedByChart.get(instance) ?? false);
        if (presentation !== "overview" && cursor !== null && cursor !== undefined) {
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
        normalized: false,
        maintainAspectRatio: false,
        ...(presentation === "overview" && !inspect ? { events: ["mousemove", "mouseout"] } : {}),
        interaction: { intersect: false, mode: "nearest", axis: "x" },
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: true,
            callbacks: {
              title: (items) =>
                items.length && items[0].parsed.x !== null
                  ? marketTime(items[0].parsed.x / 1000)
                  : "",
              label(context) {
                const value = context.parsed.y;
                return `${context.dataset.label ?? "Series"}: ${formatValue(value, chart.unit)}`;
              },
            },
          },
          decimation: {
            enabled: false,
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
                if (suppressZoomCommit.current) return;
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
                if (suppressZoomCommit.current) return;
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
            ticks: {
              callback: (value) => {
                if (mobile && dynamic.current.time.rangeSeconds > 86400) {
                  return [
                    new Intl.DateTimeFormat("en-US", {
                      timeZone: "America/Chicago",
                      month: "short",
                      day: "numeric",
                    }).format(Number(value)),
                    new Intl.DateTimeFormat("en-US", {
                      timeZone: "America/Chicago",
                      hour: "numeric",
                    }).format(Number(value)),
                  ];
                }
                return new Intl.DateTimeFormat("en-US", {
                  timeZone: "America/Chicago",
                  hour: "numeric",
                  minute: "2-digit",
                  ...(dynamic.current.time.rangeSeconds > 86400
                    ? ({ month: "short", day: "numeric" } as const)
                    : {}),
                }).format(Number(value));
              },
              autoSkip: true,
              color: "#aebdd0",
              maxRotation: 0,
              maxTicksLimit: mobile ? 3 : presentation === "featured" ? 7 : 6,
              sampleSize: 8,
            },
            grid: { color: "rgba(148, 163, 184, 0.08)" },
          },
          y: {
            ...(chart.id === "frequency" ? { suggestedMin: 59.95, suggestedMax: 60.05 } : {}),
            ...(chart.id === "fuel-mix" && presentation === "overview"
              ? { stacked: true, beginAtZero: true }
              : {}),
            ...(chart.zeroCentered
              ? {
                  suggestedMin:
                    -Math.max(
                      0,
                      ...datasets.flatMap((dataset) =>
                        dataset.data
                          .filter((point) => Number.isFinite(point.y))
                          .map((point) => Math.abs(point.y ?? 0)),
                      ),
                    ) || -1,
                  suggestedMax:
                    Math.max(
                      0,
                      ...datasets.flatMap((dataset) =>
                        dataset.data
                          .filter((point) => Number.isFinite(point.y))
                          .map((point) => Math.abs(point.y ?? 0)),
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
      if (presentation === "overview") paintCursor(instance, timestamp, isPinned);
      else instance.draw();
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
    instance.options.events =
      inspect || presentation !== "overview"
        ? ["mousemove", "mouseout", "click", "touchstart", "touchmove"]
        : ["mousemove", "mouseout"];
    if (instance.options.plugins?.tooltip) instance.options.plugins.tooltip.enabled = true;
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
  }, [interactionPolicy, inspect, presentation]);

  useEffect(() => {
    const instance = chartRef.current;
    if (!instance) return;
    instance.data.datasets = datasets;
    const xScale = instance.options.scales?.["x"];
    if (xScale) {
      xScale.min = time.start * 1000;
      xScale.max = time.end * 1000;
    }
    const yScale = instance.options.scales?.["y"];
    if (chart.zeroCentered && yScale) {
      const maximum = Math.max(
        1,
        ...datasets.flatMap((dataset) =>
          dataset.data
            .filter((point) => Number.isFinite(point.y))
            .map((point) => Math.abs(point.y ?? 0)),
        ),
      );
      yScale.suggestedMin = -maximum;
      yScale.suggestedMax = maximum;
    }
    instance.update("none");
    instance.canvas.dataset["chartReady"] = datasets.some((dataset) => dataset.data.length)
      ? "true"
      : "false";
    window.__ercotChartLifecycle ??= { constructed: 0, destroyed: 0, updated: 0 };
    window.__ercotChartLifecycle.updated += 1;
  }, [datasets, events, seriesData, time.end, time.start, chart.zeroCentered]);

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
  const stale = sourceHealth?.state === "stale" || sourceHealth?.state === "failed";
  const showStatusRow = Boolean((sourceHealth && sourceHealth.state !== "healthy") || pinned);
  const resetChartZoom = () => {
    suppressZoomCommit.current = true;
    chartRef.current?.resetZoom();
    suppressZoomCommit.current = false;
    onResetZoom();
  };
  const showDataTable = () => {
    if (!accessibleDataRef.current) return;
    accessibleDataRef.current.open = true;
    accessibleDataRef.current.querySelector("summary")?.focus();
  };

  function renderLegend(series: (typeof visibleSeries)[number], expanded: boolean) {
    const key = seriesKey(chart.id, series.id);
    const loaded = seriesData.get(key);
    const sampled = seriesStats(loaded?.points ?? []);
    const stats = loaded?.meta.stats ?? { ...sampled, energy_mwh: null };
    const hidden = hiddenSeries.has(key);
    const selected =
      !hidden &&
      visibleSeries.length > 1 &&
      visibleSeries.every(
        (candidate) =>
          candidate.id === series.id || hiddenSeries.has(seriesKey(chart.id, candidate.id)),
      );
    const legendValue =
      presentation === "overview" ? (
        <CursorLegendValue
          loaded={loaded}
          latest={stats.latest}
          unit={chart.unit}
          visible={visible}
          policy={temporalPolicy(chart.id, series)}
        />
      ) : (
        <span className="legend-latest">{formatValue(stats.latest, chart.unit)}</span>
      );
    const toggle = (
      <button
        key={key}
        aria-label={series.label}
        aria-pressed={selected}
        className={
          expanded ? "legend-table-toggle" : `legend-row ${hidden ? "legend-row-hidden" : ""}`
        }
        onClick={() => onSoloSeries(chart.id, key)}
        title={selected ? "Restore all series" : `Focus ${series.label}`}
      >
        <span
          className="legend-label"
          style={
            {
              "--series-color": frequencyColor(chart, stats.latest, series.color),
            } as React.CSSProperties
          }
        >
          <span
            className={`legend-swatch ${series.lineStyle === "dashed" ? "legend-swatch-dashed" : ""}`}
          />
          {series.label}
        </span>
        {!expanded ? legendValue : null}
      </button>
    );
    return expanded ? (
      <tr key={key} className={hidden ? "legend-row-hidden" : ""}>
        <td>{toggle}</td>
        <td>{legendValue}</td>
        <td className="legend-stats">{formatValue(stats.minimum, chart.unit)}</td>
        <td className="legend-stats">{formatValue(stats.maximum, chart.unit)}</td>
        <td className="legend-stats">{formatValue(stats.average, chart.unit)}</td>
        {chart.statisticPolicy === "power" ? (
          <td className="legend-stats">{formatValue(stats.energy_mwh, "MWh")}</td>
        ) : null}
      </tr>
    ) : (
      toggle
    );
  }

  return (
    <article
      aria-label={inspect ? "Inspect " + chart.title : undefined}
      aria-busy={loading}
      aria-modal={inspect ? "true" : undefined}
      className={`chart-card chart-card-${presentation} ${inspect ? "chart-card-inspect" : ""}`}
      data-placement-id={`${presentation}:${chart.id}`}
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
          {chart.id !== "frequency" && presentation !== "overview" ? (
            <p className="eyebrow">{chartGroupDisplayLabel(chart.group)}</p>
          ) : null}
          <h3>{chart.title}</h3>
          {chart.id !== "frequency" && (presentation !== "overview" || inspect) ? (
            <p className="chart-description">{chart.description}</p>
          ) : null}
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
              <button onClick={resetChartZoom} role="menuitem">
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
          {pinned ? <span className="status-chip status-pinned">cursor pinned</span> : null}
        </div>
      ) : null}

      {chart.id === "storage" && (presentation !== "overview" || inspect) ? (
        <StorageOperationsSummary seriesData={seriesData} sourceHealth={sourceHealth} time={time} />
      ) : null}

      {inspect && mobile ? (
        <p className="inspect-gesture-hint">
          Pinch to zoom · drag horizontally to pan · tap to pin the cursor
        </p>
      ) : null}

      {interpretation &&
      (chart.id !== "supply-demand" || inspect) &&
      hasData &&
      (presentation === "standard" || inspect) ? (
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
              Historical bands are not drawn from the latest capacity; the ratio guide is
              explanatory only.
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
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              const current = chartCoordinator.snapshot().timestamp ?? time.end;
              const next = Math.max(
                time.start,
                Math.min(
                  time.end,
                  current +
                    (event.key === "ArrowLeft" ? -1 : 1) *
                      (temporalPolicy(chart.id, visibleSeries[0]!)?.nativeCadenceSeconds ?? 300),
                ),
              );
              if (chartCoordinator.snapshot().pinned) chartCoordinator.clearPin();
              cursorTimestamp.current = next;
              chartCoordinator.publish(next);
            }
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              chartCoordinator.togglePin(cursorTimestamp.current ?? time.end);
            }
          }}
          onMouseLeave={() => chartCoordinator.publish(null)}
          onPointerMove={(event) => {
            // A narrow viewport may still have a mouse; keep touch gestures scroll-only.
            if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
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
          {presentation === "overview" ? (
            <div aria-hidden="true" className="homepage-shared-cursor" ref={cursorLineRef} />
          ) : null}
          {loading && hasData ? (
            <span className="chart-refresh-status status-chip status-partial" role="status">
              Updating selected range…
            </span>
          ) : null}
          {updateUnavailable ? (
            <div className="chart-overlay chart-error">
              Temporarily unavailable… Existing observations remain visible.
            </div>
          ) : null}
          {stale ? <div className="chart-overlay chart-stale">Showing stale data</div> : null}
          <canvas
            tabIndex={0}
            aria-label={`${chart.title}. ${allPoints.length} observations. ${interpretationDescription} Arrow keys move the shared cursor. Enter pins; Escape clears. Use the legend or CSV menu for exact values.`}
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
        <div className={`series-legend legend-${legendMode}`}>
          {legendMode === "expanded" ? (
            <table className="legend-table" aria-label={`${chart.title} series statistics`}>
              <thead>
                <tr>
                  <th scope="col">Series</th>
                  <th scope="col">Value</th>
                  <th scope="col">Min</th>
                  <th scope="col">Max</th>
                  <th scope="col">Average</th>
                  {chart.statisticPolicy === "power" ? <th scope="col">Energy</th> : null}
                </tr>
              </thead>
              <tbody>{visibleSeries.map((series) => renderLegend(series, true))}</tbody>
            </table>
          ) : (
            visibleSeries.map((series) => renderLegend(series, false))
          )}
        </div>
      ) : null}

      {presentation === "overview" ? (
        <p className="homepage-chart-note">
          {chart.id === "overview-headroom" &&
          !seriesData.get("overview-headroom:headroom")?.points.length
            ? "Headroom unavailable at this resolution: native matched observations required. PRC is independently reported."
            : chart.description}
        </p>
      ) : null}
      {hasData ? (
        <details className="accessible-data" ref={accessibleDataRef}>
          <summary>Accessible data table</summary>
          <p>
            Displayed source values. Dashed lines and * readouts indicate aggregate or unknown
            resolution; bucket width does not prove coverage. Cursor values expire independently of
            line continuity.
          </p>
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
