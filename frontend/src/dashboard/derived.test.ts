import { describe, expect, it } from "vitest";

import { absoluteErrorTrendPerMinute } from "./derived";
import type { Point } from "./types";

const series = (values: number[], spacing = 300): Point[] =>
  values.map((value, index) => [1_700_000_000 + index * spacing, value]);
const latest = (points: Point[]) => points.at(-1)?.[1];

describe("absoluteErrorTrendPerMinute", () => {
  it.each([
    ["negative recovering", [-30, -20, -10], -2],
    ["negative drifting", [-10, -20, -30], 2],
    ["positive recovering", [30, 20, 10], -2],
    ["positive drifting", [10, 20, 30], 2],
  ])("classifies %s from the slope of absolute error", (_name, values, expected) => {
    expect(latest(absoluteErrorTrendPerMinute(series(values as number[])))).toBe(expected);
  });

  it("treats a zero crossing as recovery followed by drift", () => {
    const result = absoluteErrorTrendPerMinute(series([-20, -10, 0, 10, 20]));
    expect(result[0]?.[1]).toBe(-2);
    expect(result[1]?.[1]).toBeLessThan(0);
    expect(result.at(-1)?.[1]).toBeGreaterThan(0);
  });

  it("normalizes irregular timestamps to seconds per minute", () => {
    const points: Point[] = [
      [1_000, 30],
      [1_120, 24],
      [1_420, 9],
    ];
    expect(latest(absoluteErrorTrendPerMinute(points))).toBe(-3);
  });

  it("ignores missing values and requires three valid observations", () => {
    const points: Point[] = [
      [1_000, 20],
      [1_060, Number.NaN],
      [1_120, 10],
      [1_180, 5],
    ];
    expect(absoluteErrorTrendPerMinute(points)).toEqual([[1_180, -5]]);
    expect(absoluteErrorTrendPerMinute(points.slice(0, 3))).toEqual([]);
  });
});
