import {
  canonicalDisplayPoints,
  connectionGap,
  observationAt,
  temporalPolicy,
} from "./series-temporal-policy";
import { HEADROOM_METRIC } from "./tile-planner";
import { chartDefinitions } from "./chart-config";
import type { ChartDefinition, LoadedSeries, Point, SeriesDefinition } from "./types";
import type { RankingRow } from "./api";

export const overviewChartIds = new Set([
  "supply-demand",
  "fuel-mix",
  "storage",
  "pricing",
  "frequency",
  "capacity-headroom",
]);
export const engineeringChartIds = new Set([
  "reserves",
  "dc-ties",
  "time-error",
  "time-error-recovery",
  "inertia",
]);
export const headroomChart: ChartDefinition = {
  id: "overview-headroom",
  group: "Grid conditions",
  title: "Capacity headroom & PRC",
  unit: "MW",
  statisticPolicy: "gauge",
  spikeCritical: true,
  description:
    "Derived capacity minus demand from matched Supply and Demand observations. PRC is separately reported—not added to headroom.",
  sourceUrl: chartDefinitions.find((chart) => chart.id === "supply-demand")!.sourceUrl,
  series: [
    {
      id: "headroom",
      label: "Derived headroom",
      color: "#a78bfa",
      metric: HEADROOM_METRIC,
      tags: ["source:supply_demand"],
    },
    { id: "prc", label: "Reported PRC", color: "#22d3ee" },
  ],
};

export function pairedDifference(capacity: Point[], demand: Point[]): Point[] {
  const values = new Map(demand);
  return capacity
    .filter(([ts, value]) => Number.isFinite(value) && Number.isFinite(values.get(ts)))
    .map(([ts, value]) => [ts, value - values.get(ts)!]);
}

export function homepageSeries(data: Map<string, LoadedSeries>) {
  const result = new Map(data);
  if (!result.has("overview-headroom:headroom"))
    result.set("overview-headroom:headroom", {
      points: [],
      compare: [],
      meta: {},
      error: "paired_headroom_unavailable",
    });
  const prc = data.get("capacity-headroom:prc");
  if (prc) result.set("overview-headroom:prc", prc);
  return result;
}

export function precedingObservation(
  series: LoadedSeries | undefined,
  at: number,
  maxAge: number,
  nativeCadence = 300,
) {
  return observationAt(series, at, {
    kind: "instant",
    nativeCadenceSeconds: nativeCadence,
    connectionGapSeconds: maxAge,
    cursor: { mode: "preceding", maxAgeSeconds: maxAge },
    evidence: "Legacy caller supplied cadence and age",
  });
}

export function seriesGapSeconds(chartId: string, series: SeriesDefinition, loaded?: LoadedSeries) {
  const source = temporalPolicy(chartId, series);
  if (loaded?.meta.observed_envelope_support !== undefined)
    return source?.connectionGapSeconds ?? 0;
  return connectionGap(source, loaded);
}

export function displayPoints(
  points: Point[],
  gapSeconds: number,
  support: Array<{ start: number; end: number }> = [],
) {
  const output: Array<{ x: number; y: number }> = [];
  const canonical = canonicalDisplayPoints(points);
  const allowedGap = Number.isFinite(gapSeconds) && gapSeconds >= 0 ? gapSeconds : 0;
  canonical.forEach(([ts, value], index) => {
    const prior = canonical[index - 1];
    if (
      prior &&
      ts - prior[0] > allowedGap &&
      !support.some((range) => range.start <= prior[0] && range.end >= ts)
    )
      output.push({ x: (prior[0] + allowedGap) * 1000, y: Number.NaN });
    output.push({ x: ts * 1000, y: value });
  });
  return output;
}

export function alignedGeneration(series: LoadedSeries[]) {
  const timestamps = [
    ...new Set(series.flatMap((item) => item.points.map((point) => point[0]))),
  ].sort((a, b) => a - b);
  const maps = series.map((item) => new Map(item.points));
  return maps.map((values) =>
    displayPoints(
      timestamps.map((ts) => [
        ts,
        maps.every((map) => map.has(ts) && Number.isFinite(map.get(ts)) && map.get(ts)! >= 0)
          ? values.get(ts)!
          : Number.NaN,
      ]),
      Math.max(
        ...series.map((item) =>
          connectionGap(
            temporalPolicy("fuel-mix", { id: "generation", color: "", label: "" }),
            item,
          ),
        ),
      ),
    ),
  );
}

export const marketNames: Record<string, string> = {
  HB_HOUSTON: "Houston Hub",
  HB_NORTH: "North Hub",
  HB_WEST: "West Hub",
};

export function coherentPriceSnapshots(rows: RankingRow[], now: number) {
  const valid = rows.filter(
    (row) => Number.isFinite(row.value) && Number.isFinite(row.ts) && row.ts <= now,
  );
  const newest = Math.max(...valid.map((row) => row.ts));
  return valid.filter((row) => row.ts === newest).sort((a, b) => b.value - a.value);
}
export const marketSeries: Record<string, string> = {
  HB_HOUSTON: "houston",
  HB_NORTH: "north",
  HB_WEST: "west",
};
export const marketTime = (ts: number) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(ts * 1000);
