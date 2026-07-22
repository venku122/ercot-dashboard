import type { Point } from "./types";

export type DerivedOperation = "delta" | "subtract" | "sum" | "sum_abs";

export function deriveSeries(operation: DerivedOperation, inputs: Point[][]): Point[] {
  if (!inputs.length) return [];
  if (operation === "delta") {
    const source = inputs[0] ?? [];
    return source
      .slice(1)
      .map(([timestamp, value], index) => [timestamp, value - source[index]![1]]);
  }
  const maps = inputs.map((points) => new Map(points));
  const timestamps = [...maps[0]!.keys()].filter((timestamp) =>
    maps.every((values) => values.has(timestamp)),
  );
  return timestamps.map((timestamp) => {
    const values = maps.map((points) => points.get(timestamp)!);
    if (operation === "subtract") return [timestamp, values[0]! - values[1]!];
    if (operation === "sum_abs") {
      return [timestamp, values.reduce((total, value) => total + Math.abs(value), 0)];
    }
    return [timestamp, values.reduce((total, value) => total + value, 0)];
  });
}
