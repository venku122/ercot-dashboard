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
