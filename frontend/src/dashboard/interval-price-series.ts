import type { PriceRow } from "./market-geography";
import type { LoadedSeries, SeriesTemporalPolicy } from "./types";
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
