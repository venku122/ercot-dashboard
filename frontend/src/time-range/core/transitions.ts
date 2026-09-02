import { isLiveCapableSelection, resolveTimeRange } from "./resolve";
import type {
  CalendarPresetId,
  FixedTimeRangeValue,
  FixedRangeOrigin,
  LastLiveSelection,
  PausedTimeRangeValue,
  RunningTimeRangeValue,
  TimeRangeConfig,
  TimeRangeValue,
} from "./types";

const FALLBACK_DURATION_MS = 6 * 60 * 60 * 1000;

export function createRelativeRange(
  durationMs: number,
  presetId?: string,
  timezone = "UTC",
): RunningTimeRangeValue {
  const selection = presetId
    ? ({ durationMs, kind: "relative", presetId } as const)
    : ({ durationMs, kind: "relative" } as const);
  return { playback: { kind: "running" }, selection, timezone };
}

export function createGrowingRange(fromMs: number, timezone = "UTC"): RunningTimeRangeValue {
  return { playback: { kind: "running" }, selection: { fromMs, kind: "growing" }, timezone };
}

export function createCalendarRange(
  preset: CalendarPresetId,
  timezone: string,
): RunningTimeRangeValue {
  return { playback: { kind: "running" }, selection: { kind: "calendar", preset }, timezone };
}

export function createFixedRange(
  fromMs: number,
  toMs: number,
  origin: FixedRangeOrigin,
  lastLiveSelection?: LastLiveSelection,
  timezone = "UTC",
): FixedTimeRangeValue {
  const base = {
    playback: { kind: "fixed" } as const,
    selection: { fromMs, kind: "fixed" as const, origin, toMs },
    timezone,
  };
  return lastLiveSelection ? { ...base, lastLiveSelection } : base;
}

function isFixedValue(value: TimeRangeValue): value is FixedTimeRangeValue {
  return value.playback.kind === "fixed";
}

function isRunningValue(value: TimeRangeValue): value is RunningTimeRangeValue {
  return value.playback.kind === "running";
}

function isPausedValue(value: TimeRangeValue): value is PausedTimeRangeValue {
  return value.playback.kind === "paused";
}

function lastLive(value: TimeRangeValue) {
  if (!isFixedValue(value)) {
    return { selection: value.selection, timezone: value.timezone };
  }
  return value.lastLiveSelection;
}

export function selectRelativeRange(
  value: TimeRangeValue,
  durationMs: number,
  presetId?: string,
): TimeRangeValue {
  return createRelativeRange(durationMs, presetId, value.timezone);
}

export function commitFixedTimeRange(
  value: TimeRangeValue,
  fromMs: number,
  toMs: number,
  origin: FixedRangeOrigin,
  timezone = value.timezone,
): FixedTimeRangeValue {
  const remembered = lastLive(value);
  const fixed = createFixedRange(fromMs, toMs, origin, undefined, timezone);
  return remembered ? { ...fixed, lastLiveSelection: remembered } : fixed;
}

export function pauseTimeRange(
  value: TimeRangeValue,
  nowMs: number,
  config: TimeRangeConfig,
): TimeRangeValue {
  if (!isRunningValue(value)) {
    return value;
  }
  const selection = value.selection;
  if (!isLiveCapableSelection(selection)) return value;
  const resolved = resolveTimeRange(value, nowMs, config);
  return {
    playback: { fromMs: resolved.fromMs, kind: "paused", toMs: resolved.toMs },
    selection,
    timezone: value.timezone,
  };
}

export function resumeTimeRange(value: TimeRangeValue): TimeRangeValue {
  if (!isPausedValue(value)) return value;
  const selection = value.selection;
  return { playback: { kind: "running" }, selection, timezone: value.timezone };
}

export function navigateTimeRange(
  value: TimeRangeValue,
  direction: -1 | 1,
  nowMs: number,
  config: TimeRangeConfig,
): TimeRangeValue {
  const resolved = resolveTimeRange(value, nowMs, config);
  const durationMs = resolved.toMs - resolved.fromMs;
  const fromMs = resolved.fromMs + durationMs * direction;
  const toMs = resolved.toMs + durationMs * direction;
  const remembered = lastLive(value);
  const fixed = createFixedRange(fromMs, toMs, "navigation", undefined, value.timezone);
  return remembered && fixed.selection.kind === "fixed"
    ? { ...fixed, lastLiveSelection: remembered }
    : fixed;
}

export function resetTimeRange(value: TimeRangeValue): TimeRangeValue {
  const remembered = lastLive(value);
  if (remembered) {
    return {
      playback: { kind: "running" },
      selection: remembered.selection,
      timezone: remembered.timezone,
    };
  }
  return createRelativeRange(FALLBACK_DURATION_MS, "past-6-hours", value.timezone);
}

export function changeTimeRangeTimezone(value: TimeRangeValue, timezone: string): TimeRangeValue {
  return { ...value, timezone };
}
