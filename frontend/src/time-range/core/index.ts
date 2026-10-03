import { DAY_MS, MINUTE_MS, type TimeRangeConfig } from "./types";

export const DEFAULT_TIME_RANGE_CONFIG: TimeRangeConfig = {
  defaultRelativeRange: { durationMs: 6 * 60 * 60 * 1000 },
  defaultTimezone: "UTC",
  locale: "en-US",
  maxDurationMs: 365 * DAY_MS,
  minDurationMs: 5 * MINUTE_MS,
};

export { decodeTimeRange, encodeTimeRange } from "./codec";
export { formatDuration, formatInstant, formatTimeRangeLabel } from "./format";
export {
  formatTimeRangeExpression,
  formatTimeRangePill,
  incrementTimeRangeExpression,
  parseTimeRangeExpression,
} from "./expression";
export { resolveTimeRange } from "./resolve";
export {
  formatWallTimeInput,
  isValidTimezone,
  parseWallTime,
  resolveWallTime,
  shiftInstantByCalendarDays,
} from "./timezone";
export {
  changeTimeRangeTimezone,
  commitFixedTimeRange,
  createCalendarRange,
  createFixedRange,
  createGrowingRange,
  createRelativeRange,
  navigateTimeRange,
  pauseTimeRange,
  resetTimeRange,
  resumeTimeRange,
  selectRelativeRange,
} from "./transitions";
export { DAY_MS, HOUR_MS, MINUTE_MS } from "./types";
export type {
  CalendarPresetId,
  CalendarTimeRangeSpec,
  FixedRangeOrigin,
  FixedTimeRangeSpec,
  FixedTimeRangeValue,
  GrowingTimeRangeSpec,
  LastLiveSelection,
  LiveTimeRangeSpec,
  PausedTimeRangeValue,
  RelativeTimeRangeSpec,
  ResolvedTimeWindow,
  RunningTimeRangeValue,
  TimeRangeConfig,
  TimeRangeValidationError,
  TimeRangeValidationErrorCode,
  TimeRangeValue,
  WallTimeOccurrence,
  WallTimeParseResult,
  WallTimeResolution,
} from "./types";
export type {
  ParseTimeRangeExpressionOptions,
  ParseTimeRangeExpressionResult,
  TimeRangeExpressionErrorCode,
  TimeRangeExpressionSegment,
} from "./expression";
export { validateResolvedTimeWindow, validateTimeRangeValue } from "./validate";
