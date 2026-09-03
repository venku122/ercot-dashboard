export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export type CalendarPresetId =
  | "month_to_date"
  | "previous_month"
  | "previous_week"
  | "today"
  | "week_to_date"
  | "year_to_date"
  | "yesterday";

export type FixedRangeOrigin = "custom" | "navigation" | "zoom";
export type WallTimeOccurrence = "earlier" | "later";

export type RelativeTimeRangeSpec = {
  durationMs: number;
  kind: "relative";
  presetId?: string;
};

export type GrowingTimeRangeSpec = {
  fromMs: number;
  kind: "growing";
};

export type CalendarTimeRangeSpec = {
  kind: "calendar";
  preset: CalendarPresetId;
};

export type LiveTimeRangeSpec =
  | CalendarTimeRangeSpec
  | GrowingTimeRangeSpec
  | RelativeTimeRangeSpec;

export type FixedTimeRangeSpec = {
  fromMs: number;
  kind: "fixed";
  origin: FixedRangeOrigin;
  toMs: number;
};

export type LastLiveSelection = {
  selection: LiveTimeRangeSpec;
  timezone: string;
};

export type RunningTimeRangeValue = {
  playback: { kind: "running" };
  selection: LiveTimeRangeSpec;
  timezone: string;
};

export type PausedTimeRangeValue = {
  playback: { fromMs: number; kind: "paused"; toMs: number };
  selection: LiveTimeRangeSpec;
  timezone: string;
};

export type FixedTimeRangeValue = {
  lastLiveSelection?: LastLiveSelection;
  playback: { kind: "fixed" };
  selection: FixedTimeRangeSpec;
  timezone: string;
};

export type TimeRangeValue = FixedTimeRangeValue | PausedTimeRangeValue | RunningTimeRangeValue;

export type ResolvedTimeWindow = {
  fromMs: number;
  live: boolean;
  origin?: FixedRangeOrigin;
  paused: boolean;
  timezone: string;
  toMs: number;
};

export type TimeRangeConfig = {
  defaultRelativeRange?: { durationMs: number; presetId?: string };
  defaultTimezone: string;
  locale: string;
  maxDurationMs: number;
  minDurationMs: number;
};

export type TimeRangeValidationErrorCode =
  | "from_not_before_to"
  | "invalid_instant"
  | "invalid_timezone"
  | "invalid_semantics"
  | "range_too_long"
  | "range_too_short";

export type TimeRangeValidationError = {
  code: TimeRangeValidationErrorCode;
  field: "from" | "range" | "to";
  message: string;
};

export type WallTimeParts = {
  day: number;
  hour: number;
  millisecond: number;
  minute: number;
  month: number;
  second: number;
  year: number;
};

export type WallTimeParseResult =
  | { ok: false; reason: "invalid_wall_time" }
  | { ok: true; parts: WallTimeParts };

export type WallTimeResolution =
  | { kind: "nonexistent" }
  | {
      earlierMs: number;
      kind: "ambiguous";
      laterMs: number;
    }
  | {
      instantMs: number;
      kind: "exact";
      occurrence?: WallTimeOccurrence;
    };
