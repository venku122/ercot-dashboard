import type { CompareMode, Point, TimeState } from "./types";

export function compareOffset(
  mode: CompareMode,
  time: TimeState,
  customCompareSeconds = 86400,
): number {
  if (mode === "previous_period") return time.rangeSeconds;
  if (mode === "day") return 86400;
  if (mode === "week") return 7 * 86400;
  if (mode === "custom") return customCompareSeconds;
  return 0;
}

export function compareWindow(mode: CompareMode, time: TimeState, customCompareSeconds = 86400) {
  const offset = compareOffset(mode, time, customCompareSeconds);
  return { offset, start: time.start - offset, end: time.end - offset };
}

export function alignComparison(points: Point[], offset: number): Point[] {
  return points.map(([timestamp, value]) => [timestamp + offset, value]);
}
