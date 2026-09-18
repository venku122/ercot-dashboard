import { chartDefinitions } from "./chart-config";
import type { ChartDefinition, LoadedSeries, Point } from "./types";
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
  description:
    "Derived capacity minus demand from matched Supply and Demand observations. PRC is separately reported—not added to headroom.",
  sourceUrl: chartDefinitions.find((chart) => chart.id === "supply-demand")!.sourceUrl,
  series: [
    { id: "headroom", label: "Derived headroom", color: "#a78bfa" },
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
  const capacity = data.get("supply-demand:available-capacity");
  const demand = data.get("supply-demand:demand");
  // Independent aggregate/envelope points do not prove paired observations.
  const native =
    capacity &&
    demand &&
    !capacity.error &&
    !demand.error &&
    typeof capacity.meta.bucket_seconds === "number" &&
    capacity.meta.bucket_seconds > 0 &&
    capacity.meta.bucket_seconds === demand.meta.bucket_seconds &&
    capacity.meta.bucket_seconds <= 300;
  result.set("overview-headroom:headroom", {
    points: native ? pairedDifference(capacity.points, demand.points) : [],
    compare: native ? pairedDifference(capacity.compare, demand.compare) : [],
    meta: { bucket_seconds: native ? (capacity.meta.bucket_seconds ?? null) : null },
    error: null,
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
  if (!series) return null;
  let low = 0,
    high = series.points.length - 1,
    found: Point | undefined;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const point = series.points[mid]!;
    if (point[0] <= at) {
      found = point;
      low = mid + 1;
    } else high = mid - 1;
  }
  if (!found || !Number.isFinite(found[1]) || at - found[0] > maxAge) return null;
  return {
    ts: found[0],
    value: found[1],
    aggregate: (series.meta.bucket_seconds ?? 0) > nativeCadence,
  };
}

export function displayPoints(points: Point[], gapSeconds: number) {
  const output: Array<{ x: number; y: number }> = [];
  points.forEach(([ts, value], index) => {
    const prior = points[index - 1];
    if (prior && ts - prior[0] > gapSeconds)
      output.push({ x: (prior[0] + gapSeconds) * 1000, y: Number.NaN });
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
      Math.max(600, ...series.map((item) => (item.meta.bucket_seconds ?? 0) * 2)),
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
