import { isLiveCapableSelection, resolveTimeRange } from "./resolve";
import { isValidTimezone } from "./timezone";
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
const MAX_DATE_MS = 8_640_000_000_000_000;

function assertTimezone(timezone: string) {
  if (!isValidTimezone(timezone)) throw new RangeError("invalid_timezone");
}

function assertInstant(instantMs: number) {
  if (!Number.isSafeInteger(instantMs) || Math.abs(instantMs) > MAX_DATE_MS)
    throw new RangeError("invalid_instant");
}

function assertLiveSelection(lastLiveSelection: LastLiveSelection) {
  assertTimezone(lastLiveSelection.timezone);
  if (!isLiveCapableSelection(lastLiveSelection.selection))
    throw new RangeError("invalid_semantics");
  if (lastLiveSelection.selection.kind === "relative") {
    if (
      !Number.isSafeInteger(lastLiveSelection.selection.durationMs) ||
      lastLiveSelection.selection.durationMs <= 0
    )
      throw new RangeError("invalid_duration");
  } else if (lastLiveSelection.selection.kind === "growing") {
    assertInstant(lastLiveSelection.selection.fromMs);
  }
}

export function createRelativeRange(
  durationMs: number,
  presetId: string | undefined,
  timezone: string,
): RunningTimeRangeValue {
  assertTimezone(timezone);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0)
    throw new RangeError("invalid_duration");
  const selection = presetId
    ? ({ durationMs, kind: "relative", presetId } as const)
    : ({ durationMs, kind: "relative" } as const);
  return { playback: { kind: "running" }, selection, timezone };
}

export function createGrowingRange(fromMs: number, timezone: string): RunningTimeRangeValue {
  assertTimezone(timezone);
  assertInstant(fromMs);
  return { playback: { kind: "running" }, selection: { fromMs, kind: "growing" }, timezone };
}

export function createCalendarRange(
  preset: CalendarPresetId,
  timezone: string,
): RunningTimeRangeValue {
  assertTimezone(timezone);
  return { playback: { kind: "running" }, selection: { kind: "calendar", preset }, timezone };
}

export function createFixedRange(
  fromMs: number,
  toMs: number,
  origin: FixedRangeOrigin,
  lastLiveSelection: LastLiveSelection | undefined,
  timezone: string,
): FixedTimeRangeValue {
  assertTimezone(timezone);
  assertInstant(fromMs);
  assertInstant(toMs);
  if (fromMs >= toMs) throw new RangeError("invalid_range");
  if (lastLiveSelection) assertLiveSelection(lastLiveSelection);
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
    return isLiveCapableSelection(value.selection)
      ? { selection: value.selection, timezone: value.timezone }
      : undefined;
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

export function resetTimeRange(value: TimeRangeValue, config?: TimeRangeConfig): TimeRangeValue {
  const remembered = lastLive(value);
  if (remembered) {
    if (remembered.selection.kind === "relative")
      return createRelativeRange(
        remembered.selection.durationMs,
        remembered.selection.presetId,
        remembered.timezone,
      );
    if (remembered.selection.kind === "growing")
      return createGrowingRange(remembered.selection.fromMs, remembered.timezone);
    return createCalendarRange(remembered.selection.preset, remembered.timezone);
  }
  const fallback = config?.defaultRelativeRange ?? { durationMs: FALLBACK_DURATION_MS };
  return createRelativeRange(
    fallback.durationMs,
    fallback.presetId,
    config?.defaultTimezone ?? value.timezone,
  );
}

export function changeTimeRangeTimezone(value: TimeRangeValue, timezone: string): TimeRangeValue {
  assertTimezone(timezone);
  return { ...value, timezone };
}
