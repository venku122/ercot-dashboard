import { describe, expect, it } from "vitest";
import { chartDefinitions } from "./chart-config";
import { displayPoints, seriesGapSeconds } from "./homepage-model";
import type { LoadedSeries } from "./types";
const loaded = (bucket = 1): LoadedSeries => ({
  points: [],
  compare: [],
  meta: { bucket_seconds: bucket },
  error: null,
});
describe("declared series temporal contracts", () => {
  it("connects hourly renewable forecast current and comparison samples while preserving a whole missing interval", () => {
    const chart = chartDefinitions.find((item) => item.id === "renewables")!;
    for (const id of ["wind-forecast", "solar-forecast"]) {
      const series = chart.series.find((item) => item.id === id)!;
      const gap = seriesGapSeconds(chart.id, series, loaded());
      for (const origin of [0, 86400]) {
        const points = displayPoints(
          [
            [origin, 1],
            [origin + 3600, 2],
            [origin + 10800, 3],
          ],
          gap,
        );
        expect(points[1]).toEqual({ x: (origin + 3600) * 1000, y: 2 });
        expect(points[2].y).toBeNaN();
      }
    }
  });
});

describe("transport boundaries", () => {
  it("normalizes unsorted duplicate samples without changing canonical data", () => {
    const points: [number, number][] = [
      [900, 2],
      [0, 1],
      [900, 3],
      [1800, Number.NaN],
    ];
    const before = points.map((point) => [...point]);
    expect(displayPoints(points, 1350)).toEqual([
      { x: 0, y: 1 },
      { x: 900000, y: 3 },
      { x: 1800000, y: Number.NaN },
    ]);
    expect(points).toEqual(before);
  });
  it("fails closed on an invalid connection policy", () => {
    expect(
      displayPoints(
        [
          [0, 1],
          [1, 2],
        ],
        Number.NaN,
      )[1].y,
    ).toBeNaN();
  });
});

import {
  observationAt,
  temporalPolicy,
  validTemporalPolicy,
  seriesResolution,
} from "./series-temporal-policy";
describe("independent cursor validity and provenance", () => {
  const source = {
    kind: "instant" as const,
    nativeCadenceSeconds: 900,
    connectionGapSeconds: 1350,
    cursor: { mode: "preceding" as const, maxAgeSeconds: 900 },
    evidence: "test contract",
  };
  it("expires at one unit beyond its cursor age without altering connection allowance", () => {
    const data = { ...loaded(900), points: [[0, 40]] as [number, number][] };
    expect(observationAt(data, 900, source)?.value).toBe(40);
    expect(observationAt(data, 901, source)).toBeNull();
    expect(observationAt(data, -1, source)).toBeNull();
    expect(seriesResolution(data, source)).toBe("native");
    expect(seriesResolution(loaded(3600), source)).toBe("aggregate");
    expect(observationAt({ ...data, meta: { bucket_seconds: 3600 } }, 900, source)?.coverage).toBe(
      "unknown",
    );
  });
  it("uses proven interval containment even when its timestamp is interval ending", () => {
    const data = {
      ...loaded(900),
      points: [[900, 40]] as [number, number][],
      meta: { bucket_seconds: 900, intervals: [{ timestamp: 900, start: 0, end: 900 }] },
    };
    const interval = {
      ...source,
      kind: "interval" as const,
      cursor: { mode: "interval" as const },
    };
    expect(observationAt(data, 0, interval)?.value).toBe(40);
    expect(observationAt(data, 899, interval)?.value).toBe(40);
    expect(observationAt(data, 900, interval)).toBeNull();
    expect(observationAt({ ...data, meta: {} }, 899, interval)).toBeNull();
  });
  it("rejects invalid native cadence and invalid external bucket metadata", () => {
    for (const cadence of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(validTemporalPolicy({ ...source, nativeCadenceSeconds: cadence })).toBe(false);
    for (const bucket of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(observationAt({ ...loaded(bucket), points: [[0, 1]] }, 0, source)).toBeNull();
    expect(observationAt({ ...loaded(), points: [[0, 1]] }, 0, undefined)).toBeNull();
  });
  it("rejects malformed runtime policy metadata without throwing", () => {
    for (const invalid of [
      null,
      {},
      { kind: "instant", nativeCadenceSeconds: 1, connectionGapSeconds: 1, cursor: null },
    ]) {
      expect(validTemporalPolicy(invalid as never)).toBe(false);
    }
  });
  it("inventories every configured family explicitly", () => {
    for (const chart of chartDefinitions)
      for (const series of chart.series)
        expect(temporalPolicy(chart.id, series), `${chart.id}:${series.id}`).toBeDefined();
    expect(temporalPolicy("unverified", { id: "unknown", label: "", color: "" })).toBeUndefined();
  });
  it("documents exact connection boundary separately from missing whole intervals", () => {
    expect(
      displayPoints(
        [
          [0, 1],
          [1350, 2],
        ],
        1350,
      ),
    ).toHaveLength(2);
    expect(
      displayPoints(
        [
          [0, 1],
          [1351, 2],
        ],
        1350,
      )[1].y,
    ).toBeNaN();
  });
});
