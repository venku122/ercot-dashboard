import { expect, it } from "vitest";
import * as interval from "./interval-price-series";
import type { PriceRow } from "./market-geography";
it("interval geometry starts at proven delivery start and jumps at the shared boundary", () => {
  const points: [number, number][] = [
    [7200, -50],
    [8100, 99],
  ];
  const bounds = [
    { timestamp: 7200, start: 6300, end: 7200 },
    { timestamp: 8100, start: 7200, end: 8100 },
  ];
  const plot = interval.intervalPlotPoints;
  expect(typeof plot).toBe("function");
  expect(plot(points, bounds)).toEqual([
    { x: 6300000, y: -50 },
    { x: 7200000, y: -50 },
    { x: 7200000, y: 99 },
    { x: 8100000, y: 99 },
  ]);
  expect(points).toEqual([
    [7200, -50],
    [8100, 99],
  ]);
});
it("missing interval metadata and unsupported gaps are never interpolated", () => {
  const plot = interval.intervalPlotPoints;
  expect(typeof plot).toBe("function");
  const rows = [
    { target_ts: 7200, interval_start: 6300, interval_end: 7200, value: -50 },
    { target_ts: 9000, interval_start: 8100, interval_end: 9000, value: 99 },
  ] as PriceRow[];
  const loaded = interval.intervalPriceSeries(rows, 6300, 9000, false);
  const geometry = plot(loaded.points, loaded.meta.intervals!);
  expect(geometry[2]!.y).toBeNaN();
  expect(geometry[3]).toEqual({ x: 8100000, y: 99 });
  expect(plot(loaded.points, [])).toEqual([]);
});
it("clips verified held drawing support inside selected bounds without changing native records", () => {
  const points: [number, number][] = [[7200, 48.23]];
  const bounds = [{ timestamp: 7200, start: 6300, end: 7200 }];
  expect(interval.intervalPlotPoints(points, bounds, { start: 6301, end: 6901 })).toEqual([
    { x: 6301000, y: 48.23 },
    { x: 6901000, y: 48.23 },
  ]);
  expect(points).toEqual([[7200, 48.23]]);
  expect(bounds).toEqual([{ timestamp: 7200, start: 6300, end: 7200 }]);
});
it("comparison drawing uses its own verified support and preserves missing intervals", () => {
  const current: [number, number][] = [[7200, 48.23]];
  const comparison: [number, number][] = [
    [6600, 31],
    [8100, 29],
  ];
  const priorBounds = [
    { timestamp: 6600, start: 5700, end: 6600 },
    { timestamp: 8100, start: 7200, end: 8100 },
  ];
  const window = { start: 6301, end: 7801 };
  const drawing = interval.intervalPlotPoints(comparison, priorBounds, window);
  expect(drawing[0]).toEqual({ x: 6301000, y: 31 });
  expect(drawing[1]).toEqual({ x: 6600000, y: 31 });
  expect(drawing[2]!.y).toBeNaN();
  expect(drawing[3]).toEqual({ x: 7200000, y: 29 });
  expect(drawing[4]).toEqual({ x: 7801000, y: 29 });
  expect(current).toEqual([[7200, 48.23]]);
  expect(comparison).toEqual([
    [6600, 31],
    [8100, 29],
  ]);
  expect(interval.intervalPlotPoints(comparison, [], window)).toEqual([]);
});
