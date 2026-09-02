import {
  createFixedRange,
  createRelativeRange,
  DAY_MS,
  pauseTimeRange,
  resolveTimeRange,
  validateResolvedTimeWindow,
  type CalendarPreset,
  type DurationPreset,
  type TimeRangeConfig,
  type TimeRangeValue,
} from "../time-range";
import type { TimeState } from "./types";

const HOUR_MS = 3_600_000;

export const ERCOT_TIME_RANGE_CONFIG: TimeRangeConfig = {
  defaultTimezone: "America/Chicago",
  locale: "en-US",
  maxDurationMs: 365 * DAY_MS,
  minDurationMs: 5 * 60_000,
};

export const ERCOT_DURATION_PRESETS: readonly DurationPreset[] = [
  { durationMs: HOUR_MS, id: "past-1-hour", label: "Past 1 hour" },
  { durationMs: 6 * HOUR_MS, id: "past-6-hours", label: "Past 6 hours" },
  { durationMs: 12 * HOUR_MS, id: "past-12-hours", label: "Past 12 hours" },
  { durationMs: 24 * HOUR_MS, id: "past-24-hours", label: "Past 24 hours" },
  { durationMs: 3 * DAY_MS, id: "past-3-days", label: "Past 3 days" },
  { durationMs: 7 * DAY_MS, id: "past-7-days", label: "Past 7 days" },
  { durationMs: 30 * DAY_MS, id: "past-30-days", label: "Past 30 days" },
  { durationMs: 365 * DAY_MS, id: "past-12-months", label: "Past 12 months" },
];

export const ERCOT_CALENDAR_PRESETS: readonly CalendarPreset[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "week_to_date", label: "Week to date" },
  { id: "month_to_date", label: "Month to date" },
  { id: "previous_week", label: "Previous week" },
  { id: "previous_month", label: "Previous month" },
  { id: "year_to_date", label: "Year to date" },
];

function finiteSeconds(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function presetForDuration(durationMs: number): DurationPreset | undefined {
  return ERCOT_DURATION_PRESETS.find((preset) => preset.durationMs === durationMs);
}

export function toErcotTimeState(value: TimeRangeValue, nowMs: number): TimeState {
  const resolved = resolveTimeRange(value, nowMs, ERCOT_TIME_RANGE_CONFIG);
  return {
    end: resolved.toMs / 1000,
    mode: resolved.live ? "live" : "fixed",
    paused: resolved.paused,
    rangeSeconds: (resolved.toMs - resolved.fromMs) / 1000,
    start: resolved.fromMs / 1000,
  };
}

export function legacyTimeRangeFromUrl(
  params: URLSearchParams,
  nowMs: number,
): TimeRangeValue | null {
  const rangeSeconds = finiteSeconds(params.get("range"));
  if (rangeSeconds === null) return null;
  const durationMs = rangeSeconds * 1000;
  if (
    durationMs < ERCOT_TIME_RANGE_CONFIG.minDurationMs ||
    durationMs > ERCOT_TIME_RANGE_CONFIG.maxDurationMs
  ) {
    return null;
  }
  const preset = presetForDuration(durationMs);
  const relative = createRelativeRange(
    durationMs,
    preset?.id,
    ERCOT_TIME_RANGE_CONFIG.defaultTimezone,
  );
  if (params.get("live") !== "0") {
    return params.get("paused") === "1"
      ? pauseTimeRange(relative, nowMs, ERCOT_TIME_RANGE_CONFIG)
      : relative;
  }
  const fromSeconds = finiteSeconds(params.get("from"));
  const toSeconds = finiteSeconds(params.get("to"));
  if (fromSeconds === null || toSeconds === null) return null;
  const fromMs = fromSeconds * 1000;
  const toMs = toSeconds * 1000;
  if (validateResolvedTimeWindow({ fromMs, toMs }, ERCOT_TIME_RANGE_CONFIG)) return null;
  return createFixedRange(
    fromMs,
    toMs,
    "custom",
    relative.selection,
    ERCOT_TIME_RANGE_CONFIG.defaultTimezone,
  );
}

export function writeLegacyTimeRangeProjection(
  value: TimeRangeValue,
  source: URLSearchParams,
  nowMs: number,
): URLSearchParams {
  const params = new URLSearchParams(source);
  const resolved = resolveTimeRange(value, nowMs, ERCOT_TIME_RANGE_CONFIG);
  params.set("range", String(Math.round((resolved.toMs - resolved.fromMs) / 1000)));
  if (value.selection.kind === "relative") {
    params.set("live", "1");
    params.delete("from");
    params.delete("to");
    if (value.playback.kind === "paused") params.set("paused", "1");
    else params.delete("paused");
  } else {
    params.set("live", "0");
    params.set("from", String(Math.round(resolved.fromMs / 1000)));
    params.set("to", String(Math.round(resolved.toMs / 1000)));
    params.delete("paused");
  }
  return params;
}
