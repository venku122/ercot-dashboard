import { describe, expect, it } from "vitest";
import {
  alignedGeneration,
  coherentPriceSnapshots,
  displayPoints,
  seriesGapSeconds,
  homepageSeries,
  marketTime,
  pairedDifference,
  precedingObservation,
} from "./homepage-model";
import { dashboardStateFromUrl } from "./url-state";
import { toErcotTimeState } from "./time-range-adapter";
import type { LoadedSeries, Point } from "./types";
const loaded = (points: Point[], bucket = 300): LoadedSeries => ({
  points,
  compare: [],
  meta: { bucket_seconds: bucket },
  error: null,
});
describe("chart-first homepage contracts", () => {
  it("DATA-01 joins headroom by exact timestamp, never row index or nearest time", () => {
    expect(
      pairedDifference(
        [
          [0, 90],
          [300, 92],
          [600, 95],
        ],
        [
          [0, 70],
          [301, 71],
          [600, 73],
        ],
      ),
    ).toEqual([
      [0, 20],
      [600, 22],
    ]);
  });
  it("DATA-01 DATA-03 refuses coarse or incompatible headroom and never substitutes PRC", () => {
    const source = new Map([
      ["supply-demand:available-capacity", loaded([[0, 90]])],
      ["supply-demand:demand", loaded([[0, 70]])],
    ]);
    expect(homepageSeries(source).get("overview-headroom:headroom")?.error).toBe(
      "paired_headroom_unavailable",
    );
    expect(homepageSeries(source).has("overview-headroom:prc")).toBe(false);
    source.get("supply-demand:demand")!.meta.bucket_seconds = 3600;
    expect(homepageSeries(source).get("overview-headroom:headroom")?.points).toEqual([]);
  });
  it("DATA-04 keeps stack members aligned and missing categories out of every total", () => {
    const result = alignedGeneration([
      loaded([
        [0, 10],
        [300, 20],
      ]),
      loaded([[0, 5]]),
    ]);
    expect(result.map((points) => points[0].y)).toEqual([10, 5]);
    expect(result.every((points) => Number.isNaN(points[1].y))).toBe(true);
  });
  it("DATA-04 preserves observed zero, rejects negative generation, and has no percentage denominator", () => {
    const result = alignedGeneration([
      loaded([
        [0, 0],
        [300, -10],
      ]),
      loaded([
        [0, 0],
        [300, 5],
      ]),
    ]);
    expect(result.map((points) => points[0].y)).toEqual([0, 0]);
    expect(result.every((points) => Number.isNaN(points[1].y))).toBe(true);
  });
  it("DATA-06 DATA-08 display-only gaps preserve signs, spikes and source timestamps", () => {
    const points: Point[] = [
      [0, -150],
      [300, 5000],
      [1800, 20],
    ];
    const result = displayPoints(points, 600);
    expect(result.filter((point) => Number.isFinite(point.y))).toEqual([
      { x: 0, y: -150 },
      { x: 300000, y: 5000 },
      { x: 1800000, y: 20 },
    ]);
    expect(result[2].y).toBeNaN();
    expect(points).toHaveLength(3);
  });
  it("DATA-07 ranks only same collection time, preserving negative values and excluding future records", () => {
    expect(
      coherentPriceSnapshots(
        [
          { tag: "old", ts: 1, value: 999 },
          { tag: "negative", ts: 2, value: -50 },
          { tag: "normal", ts: 2, value: 40 },
          { tag: "future", ts: 4, value: 999 },
        ],
        3,
      ).map((row) => row.tag),
    ).toEqual(["normal", "negative"]);
  });
  it("CURSOR-01 looks up preceding samples independently across mixed cadence arrays", () => {
    expect(
      precedingObservation(
        loaded(
          [
            [100, 1],
            [101, 2],
            [102, 3],
          ],
          1,
        ),
        101.5,
        2,
      )?.value,
    ).toBe(2);
    expect(
      precedingObservation(
        loaded([
          [0, 10],
          [300, 20],
        ]),
        101.5,
        600,
      )?.value,
    ).toBe(10);
    expect(precedingObservation(loaded([[300, 20]]), 101.5, 600)).toBeNull();
  });
  it("CURSOR-02 CURSOR-03 rejects expired samples and labels coarse buckets", () => {
    expect(precedingObservation(loaded([[0, 10]]), 601, 600)).toBeNull();
    expect(precedingObservation(loaded([[0, 10]], 3600), 100, 7200)?.aggregate).toBe(true);
  });
  it("TIME-01 explicit six hours wins; a new overview defaults to 24 hours", () => {
    const now = 1_800_000_000;
    const explicit = dashboardStateFromUrl(
      new URL("http://localhost/?range=21600&live=1&unknown=keep"),
      now,
    );
    const defaults = dashboardStateFromUrl(new URL("http://localhost/"), now);
    expect(toErcotTimeState(explicit.time, now * 1000).rangeSeconds).toBe(21600);
    expect(toErcotTimeState(defaults.time, now * 1000).rangeSeconds).toBe(86400);
    expect(defaults.legendMode).toBe("compact");
  });
  it("TIME-02 repeated Chicago hours remain distinguishable by UTC offset abbreviation", () => {
    expect(marketTime(Date.parse("2026-11-01T06:30:00Z") / 1000)).toContain("CDT");
    expect(marketTime(Date.parse("2026-11-01T07:30:00Z") / 1000)).toContain("CST");
  });
});

describe("native chart cadence", () => {
  it("connects fifteen-minute prices while retaining an actual missing interval", () => {
    const gap = seriesGapSeconds(
      "pricing",
      { id: "houston", label: "Houston", color: "blue" },
      loaded([], 1),
    );
    const points = displayPoints(
      [
        [0, 40],
        [900, 50],
        [1800, 60],
        [3600, 70],
      ],
      gap,
    );
    expect(points.slice(0, 3).every((point) => Number.isFinite(point.y))).toBe(true);
    expect(points[3].y).toBeNaN();
  });
  it("connects hourly demand forecasts without connecting missing hours", () => {
    const gap = seriesGapSeconds(
      "supply-demand",
      { id: "forecast-demand", label: "Forecast", color: "gray" },
      loaded([], 1),
    );
    const points = displayPoints(
      [
        [0, 60000],
        [3600, 61000],
        [10800, 62000],
      ],
      gap,
    );
    expect(points[1]).toEqual({ x: 3600000, y: 61000 });
    expect(points[2].y).toBeNaN();
  });
  it("retains the finer cadence and coarse bucket gap policies", () => {
    const series = { id: "demand", label: "Demand", color: "blue" };
    expect(seriesGapSeconds("supply-demand", series, loaded([], 1))).toBe(600);
    expect(seriesGapSeconds("supply-demand", series, loaded([], 3600))).toBe(7200);
  });
});
