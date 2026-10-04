import { canonicalDisplayPoints } from "./series-temporal-policy";
import type { PriceRow } from "./market-geography";
import type { LoadedSeries, SeriesTemporalPolicy, Point } from "./types";
import { marketTime } from "./homepage-model";

export const intervalPriceTemporalPolicy: SeriesTemporalPolicy = {
  kind: "interval",
  nativeCadenceSeconds: 900,
  connectionGapSeconds: 900,
  cursor: { mode: "interval" },
  evidence: "NP6-905-CD verified 900-second delivery bounds; timestamp labels interval ending",
};

export function intervalPriceSeries(
  rows: PriceRow[],
  start: number,
  end: number,
  error: boolean,
): LoadedSeries {
  return {
    points: rows.map((row) => [row.target_ts, row.value]),
    compare: [],
    error: error ? "Interval history unavailable for this point/window" : null,
    meta: {
      bucket_seconds: 900,
      since: start,
      until: end,
      coverage: "unknown",
      intervals: rows.flatMap((row) =>
        typeof row.interval_start === "number" &&
        Number.isFinite(row.interval_start) &&
        row.interval_end === row.target_ts &&
        row.interval_start + 900 === row.interval_end
          ? [{ timestamp: row.target_ts, start: row.interval_start, end: row.interval_end }]
          : [],
      ),
    },
  };
}

export function seriesIntervalLabel(loaded: LoadedSeries | undefined, timestamp: number) {
  const interval = loaded?.meta.intervals?.find((item) => item.timestamp === timestamp);
  return interval
    ? `Interval ending ${marketTime(interval.end)} · delivery [${marketTime(interval.start)}, ${marketTime(interval.end)})`
    : "Verified interval bounds unavailable";
}

// Display geometry represents verified held interval values; it is not a new observation array.
export function intervalPlotPoints(
  points: Point[],
  bounds: NonNullable<LoadedSeries["meta"]["intervals"]>,
  window?: { start: number; end: number },
) {
  if (
    window &&
    (!Number.isFinite(window.start) || !Number.isFinite(window.end) || window.end <= window.start)
  )
    return [];
  const values = new Map(canonicalDisplayPoints(points));
  const intervals = bounds
    .filter(
      (item) =>
        Number.isFinite(item.start) &&
        Number.isFinite(item.end) &&
        item.start < item.end &&
        Number.isFinite(values.get(item.timestamp)),
    )
    .sort((a, b) => a.start - b.start);
  const geometry: Array<{ x: number; y: number }> = [];
  let priorEnd: number | null = null;
  for (const interval of intervals) {
    const start = Math.max(interval.start, window?.start ?? interval.start);
    const end = Math.min(interval.end, window?.end ?? interval.end);
    if (start >= end) continue;
    if (priorEnd !== null && start < priorEnd) return [];
    if (priorEnd !== null && start !== priorEnd)
      geometry.push({ x: priorEnd * 1000, y: Number.NaN });
    const value = values.get(interval.timestamp)!;
    // Clipped drawing vertices describe held support, never canonical source observations.
    geometry.push({ x: start * 1000, y: value }, { x: end * 1000, y: value });
    priorEnd = end;
  }
  return geometry;
}
