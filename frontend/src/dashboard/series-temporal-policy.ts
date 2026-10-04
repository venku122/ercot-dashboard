import type { LoadedSeries, Point, SeriesDefinition, SeriesTemporalPolicy } from "./types";

const policy = (
  kind: SeriesTemporalPolicy["kind"],
  nativeCadenceSeconds: number | null,
  connectionGapSeconds: number,
  maxAgeSeconds: number,
  evidence: string,
): SeriesTemporalPolicy => ({
  kind,
  nativeCadenceSeconds,
  connectionGapSeconds,
  cursor: { mode: "preceding", maxAgeSeconds },
  evidence,
});
const fiveMinute = policy(
  "instant",
  300,
  600,
  600,
  "ercot-collector/_lib.ts metricSeries default; dashboard source timestamps",
);
const realtime = policy(
  "instant",
  60,
  600,
  60,
  "ercot-collector/grid.ts capturedAt; collection cadence only",
);
const hourly = policy(
  "forecast",
  3600,
  5400,
  5400,
  "ercot-collector/wind_solar.ts:64 declares hourly source rows",
);
// These are declared contracts, not cadence estimates from a returned sample set.
export const chartTemporalPolicies: Record<string, SeriesTemporalPolicy> = {
  "supply-demand": fiveMinute,
  "fuel-mix": fiveMinute,
  storage: fiveMinute,
  renewables: hourly,
  "generation-outages": policy(
    "instant",
    null,
    0,
    0,
    "Source row timestamp known; native publication cadence unverified",
  ),
  pricing: policy(
    "instant",
    900,
    1350,
    1800,
    "Legacy ercot-collector/prices.ts dashboard price observations; settlement bounds unverified",
  ),
  frequency: policy(
    "instant",
    60,
    60,
    60,
    "ercot-collector/grid.ts records once per minute, not one-second source samples",
  ),
  "dc-ties": realtime,
  "capacity-headroom": realtime,
  "overview-headroom": fiveMinute,
  "time-error": realtime,
  "time-error-recovery": realtime,
  inertia: realtime,
  reserves: policy("instant", 60, 600, 600, "ercot-collector/ancillary.ts interval 60"),
  "ancillary-regulation": policy(
    "instant",
    60,
    600,
    600,
    "ercot-collector/ancillary.ts interval 60",
  ),
  "ancillary-reserves": policy("instant", 60, 600, 600, "ercot-collector/ancillary.ts interval 60"),
  eea: policy("discrete", null, 0, 0, "Event state has no guaranteed persistence interval"),
  "weather-temperature": policy(
    "instant",
    null,
    5400,
    5400,
    "METAR obsTime irregular; 30 minute polling is not publication cadence",
  ),
  "weather-wind": policy(
    "instant",
    null,
    5400,
    5400,
    "METAR obsTime irregular; 30 minute polling is not publication cadence",
  ),
  "collector-duty-cycle": policy(
    "instant",
    null,
    0,
    0,
    "Collection instrumentation varies by task; exact observations only",
  ),
};
export function temporalPolicy(
  chartId: string,
  series: SeriesDefinition,
): SeriesTemporalPolicy | undefined {
  if (series.temporal) return validTemporalPolicy(series.temporal) ? series.temporal : undefined;
  if (chartId === "supply-demand" && series.id === "forecast-demand")
    return {
      ...hourly,
      cursor: { mode: "interval" },
      evidence:
        "NP3-565 archived forecast hourEnding and proven half-open delivery bounds; publication and retrieval clocks remain separate",
    };
  return chartTemporalPolicies[chartId];
}
export function validTemporalPolicy(candidate: unknown): candidate is SeriesTemporalPolicy {
  if (!candidate || typeof candidate !== "object") return false;
  const value = candidate as SeriesTemporalPolicy;
  if (!value.cursor || typeof value.cursor !== "object" || typeof value.evidence !== "string")
    return false;
  const nonnegative = (number: number) => Number.isFinite(number) && number >= 0;
  return (
    ["instant", "interval", "forecast", "discrete"].includes(value.kind) &&
    (value.nativeCadenceSeconds === null ||
      (Number.isFinite(value.nativeCadenceSeconds) && value.nativeCadenceSeconds > 0)) &&
    nonnegative(value.connectionGapSeconds) &&
    (value.cursor.mode === "interval" ||
      (value.cursor.mode === "preceding" && nonnegative(value.cursor.maxAgeSeconds)))
  );
}
const canonicalCache = new WeakMap<Point[], Point[]>();
export function canonicalDisplayPoints(points: Point[]): Point[] {
  const cached = canonicalCache.get(points);
  if (cached) return cached;
  const values = new Map<number, number>();
  for (const [timestamp, value] of points)
    if (Number.isFinite(timestamp))
      values.set(timestamp, Number.isFinite(value) ? value : Number.NaN);
  const result = [...values].sort(([left], [right]) => left - right);
  canonicalCache.set(points, result);
  return result;
}
export function seriesResolution(
  loaded: LoadedSeries | undefined,
  source: SeriesTemporalPolicy | undefined,
) {
  const bucket = loaded?.meta.bucket_seconds;
  if (
    !source ||
    !validTemporalPolicy(source) ||
    typeof bucket !== "number" ||
    !Number.isFinite(bucket) ||
    bucket <= 0 ||
    source.nativeCadenceSeconds === null
  )
    return "unknown" as const;
  return bucket > source.nativeCadenceSeconds ? ("aggregate" as const) : ("native" as const);
}
export function connectionGap(
  source: SeriesTemporalPolicy | undefined,
  loaded?: LoadedSeries,
): number {
  if (!source || !validTemporalPolicy(source)) return 0;
  const bucket = loaded?.meta.bucket_seconds;
  if (bucket !== undefined && bucket !== null && (!Number.isFinite(bucket) || bucket <= 0))
    return 0;
  // Coarse plots represent aggregates, not proof of native continuity or cursor persistence.
  if (source.connectionGapSeconds === 0) return 0;
  // A declared native bucket cannot widen the source gap contract: a missing
  // whole hourly observation must still break the line. Coarse aggregates have
  // their own bucket spacing, never native-observation semantics.
  return source.nativeCadenceSeconds !== null &&
    typeof bucket === "number" &&
    bucket > source.nativeCadenceSeconds
    ? Math.max(source.connectionGapSeconds, bucket * 2)
    : source.connectionGapSeconds;
}
export function observationAt(
  loaded: LoadedSeries | undefined,
  at: number,
  source: SeriesTemporalPolicy | undefined,
) {
  if (!loaded || !Number.isFinite(at) || !source || !validTemporalPolicy(source)) return null;
  const bucket = loaded.meta.bucket_seconds;
  if (bucket !== undefined && bucket !== null && (!Number.isFinite(bucket) || bucket <= 0))
    return null;
  const points = canonicalDisplayPoints(loaded.points);
  if (source.cursor.mode === "interval") {
    const intervals = loaded.meta.intervals?.filter(
      (item) =>
        Number.isFinite(item.timestamp) &&
        Number.isFinite(item.start) &&
        Number.isFinite(item.end) &&
        item.start < item.end &&
        at >= item.start &&
        at < item.end,
    );
    if (!intervals || intervals.length !== 1) return null;
    const match = points.find(([timestamp]) => timestamp === intervals[0]!.timestamp);
    if (!match || !Number.isFinite(match[1])) return null;
    const resolution = seriesResolution(loaded, source);
    return {
      ts: match[0],
      value: match[1],
      aggregate: resolution === "aggregate",
      resolution,
      coverage: loaded.meta.coverage ?? "unknown",
    };
  }
  let low = 0,
    high = points.length - 1,
    found: Point | undefined;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const point = points[mid]!;
    if (point[0] <= at) {
      found = point;
      low = mid + 1;
    } else high = mid - 1;
  }
  if (!found || !Number.isFinite(found[1])) return null;
  if (at - found[0] > source.cursor.maxAgeSeconds) return null;
  const resolution = seriesResolution(loaded, source);
  return {
    ts: found[0],
    value: found[1],
    aggregate: resolution === "aggregate",
    resolution,
    coverage: resolution === "native" ? "source observations" : (loaded.meta.coverage ?? "unknown"),
  };
}
