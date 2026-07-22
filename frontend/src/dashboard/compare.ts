import type { CompareMode, Point, TimeState } from "./types";
import { shiftChicagoCalendar } from "./zoned-time";

export function compareOffset(
  mode: CompareMode,
  time: TimeState,
  customCompareSeconds = 86400,
): number {
  if (mode === "previous_period") return time.rangeSeconds;
  if (mode === "day") return time.end - shiftChicagoCalendar(time.end, -1);
  if (mode === "week") return time.end - shiftChicagoCalendar(time.end, -7);
  if (mode === "custom") return customCompareSeconds;
  return 0;
}

export function compareWindow(mode: CompareMode, time: TimeState, customCompareSeconds = 86400) {
  const offset = compareOffset(mode, time, customCompareSeconds);
  if (mode === "day" || mode === "week") {
    const days = mode === "day" ? -1 : -7;
    return {
      offset,
      start: shiftChicagoCalendar(time.start, days),
      end: shiftChicagoCalendar(time.end, days),
    };
  }
  return { offset, start: time.start - offset, end: time.end - offset };
}

export function alignComparisonForMode(
  points: Point[],
  mode: CompareMode,
  offset: number,
): Point[] {
  if (mode === "day" || mode === "week") {
    const days = mode === "day" ? 1 : 7;
    return points.map(([timestamp, value]) => [shiftChicagoCalendar(timestamp, days), value]);
  }
  return alignComparison(points, offset);
}

export function alignComparison(points: Point[], offset: number): Point[] {
  return points.map(([timestamp, value]) => [timestamp + offset, value]);
}
