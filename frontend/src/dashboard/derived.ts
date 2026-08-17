import type { Point } from "./types";

export type DerivedOperation = "absolute_error_slope" | "delta" | "subtract" | "sum" | "sum_abs";

export function absoluteErrorTrendPerMinute(points: Point[], windowSeconds = 15 * 60): Point[] {
  const valid = [...points]
    .filter(([, value]) => Number.isFinite(value))
    .sort(([left], [right]) => left - right);
  const output: Point[] = [];
  for (let index = 0; index < valid.length; index += 1) {
    const current = valid[index]!;
    const window = valid.slice(0, index + 1).filter(([timestamp]) => {
      return timestamp >= current[0] - windowSeconds && timestamp <= current[0];
    });
    if (window.length < 3) continue;
    const slopes: number[] = [];
    for (let left = 0; left < window.length - 1; left += 1) {
      for (let right = left + 1; right < window.length; right += 1) {
        const elapsedMinutes = (window[right]![0] - window[left]![0]) / 60;
        if (elapsedMinutes <= 0) continue;
        slopes.push((Math.abs(window[right]![1]) - Math.abs(window[left]![1])) / elapsedMinutes);
      }
    }
    if (!slopes.length) continue;
    slopes.sort((left, right) => left - right);
    const middle = Math.floor(slopes.length / 2);
    const median =
      slopes.length % 2 ? slopes[middle]! : (slopes[middle - 1]! + slopes[middle]!) / 2;
    output.push([current[0], median]);
  }
  return output;
}

export function deriveSeries(operation: DerivedOperation, inputs: Point[][]): Point[] {
  if (!inputs.length) return [];
  if (operation === "absolute_error_slope") {
    return absoluteErrorTrendPerMinute(inputs[0] ?? []);
  }
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
