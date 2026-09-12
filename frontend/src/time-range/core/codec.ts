import { isValidTimezone } from "./timezone";
import {
  createCalendarRange,
  createFixedRange,
  createGrowingRange,
  createRelativeRange,
} from "./transitions";
import type {
  CalendarPresetId,
  FixedRangeOrigin,
  FixedTimeRangeValue,
  LastLiveSelection,
  LiveTimeRangeSpec,
  TimeRangeConfig,
  TimeRangeValue,
} from "./types";
import { validateResolvedTimeWindow, validateTimeRangeValue } from "./validate";

const calendarPresets = new Set<CalendarPresetId>([
  "month_to_date",
  "previous_month",
  "previous_week",
  "today",
  "week_to_date",
  "year_to_date",
  "yesterday",
]);
const origins = new Set<FixedRangeOrigin>(["custom", "navigation", "zoom"]);
const ownedSuffixes = [
  "from_ms",
  "kind",
  "last_kind",
  "last_preset",
  "last_tz",
  "last_value",
  "origin",
  "play",
  "preset",
  "to_ms",
  "tz",
  "value",
] as const;

function key(prefix: string, suffix: (typeof ownedSuffixes)[number]): string {
  return `${prefix}_${suffix}`;
}

function safeInteger(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isFixedValue(value: TimeRangeValue): value is FixedTimeRangeValue {
  return value.playback.kind === "fixed";
}

function setSelection(
  params: URLSearchParams,
  prefix: string,
  selection: LiveTimeRangeSpec,
  selectionPrefix: "" | "last_" = "",
) {
  params.set(key(prefix, `${selectionPrefix}kind`), selection.kind);
  if (selection.kind === "relative") {
    params.set(key(prefix, `${selectionPrefix}value`), String(selection.durationMs));
    if (selection.presetId) params.set(key(prefix, `${selectionPrefix}preset`), selection.presetId);
  } else if (selection.kind === "growing") {
    params.set(key(prefix, `${selectionPrefix}value`), String(selection.fromMs));
  } else {
    params.set(key(prefix, `${selectionPrefix}value`), selection.preset);
  }
}

export function encodeTimeRange(
  value: TimeRangeValue,
  source = new URLSearchParams(),
  prefix = "time",
): URLSearchParams {
  const params = new URLSearchParams(source);
  for (const suffix of ownedSuffixes) params.delete(key(prefix, suffix));
  params.set(key(prefix, "tz"), value.timezone);
  params.set(key(prefix, "play"), value.playback.kind);
  if (isFixedValue(value)) {
    params.set(key(prefix, "kind"), "fixed");
    params.set(key(prefix, "from_ms"), String(value.selection.fromMs));
    params.set(key(prefix, "to_ms"), String(value.selection.toMs));
    params.set(key(prefix, "origin"), value.selection.origin);
    if (value.lastLiveSelection) {
      setSelection(params, prefix, value.lastLiveSelection.selection, "last_");
      params.set(key(prefix, "last_tz"), value.lastLiveSelection.timezone);
    }
    return params;
  }
  setSelection(params, prefix, value.selection);
  if (value.playback.kind === "paused") {
    params.set(key(prefix, "from_ms"), String(value.playback.fromMs));
    params.set(key(prefix, "to_ms"), String(value.playback.toMs));
  }
  return params;
}

function parseLiveSelection(
  params: URLSearchParams,
  config: TimeRangeConfig,
  prefix: string,
  selectionPrefix: "" | "last_" = "",
): LiveTimeRangeSpec | null {
  const kindValue = params.get(key(prefix, `${selectionPrefix}kind`));
  const value = params.get(key(prefix, `${selectionPrefix}value`));
  if (kindValue === "relative") {
    const durationMs = safeInteger(value);
    if (
      durationMs === null ||
      durationMs < config.minDurationMs ||
      durationMs > config.maxDurationMs
    ) {
      return null;
    }
    const presetId = params.get(key(prefix, `${selectionPrefix}preset`));
    return presetId ? { durationMs, kind: "relative", presetId } : { durationMs, kind: "relative" };
  }
  if (kindValue === "growing") {
    const fromMs = safeInteger(value);
    if (fromMs === null || Math.abs(fromMs) > 8_640_000_000_000_000) {
      return null;
    }
    return { fromMs, kind: "growing" };
  }
  if (kindValue === "calendar" && calendarPresets.has(value as CalendarPresetId)) {
    return { kind: "calendar", preset: value as CalendarPresetId };
  }
  return null;
}

function parseLastLiveSelection(
  params: URLSearchParams,
  config: TimeRangeConfig,
  prefix: string,
): LastLiveSelection | null {
  const timezone = params.get(key(prefix, "last_tz"));
  if (!timezone || !isValidTimezone(timezone)) return null;
  const selection = parseLiveSelection(params, config, prefix, "last_");
  return selection ? { selection, timezone } : null;
}

export function decodeTimeRange(
  params: URLSearchParams,
  config: TimeRangeConfig,
  nowMs: number,
  prefix = "time",
): TimeRangeValue | null {
  const timezone = params.get(key(prefix, "tz"));
  const playback = params.get(key(prefix, "play"));
  const kindValue = params.get(key(prefix, "kind"));
  if (!timezone || !isValidTimezone(timezone)) return null;
  if (kindValue === "fixed") {
    if (playback !== "fixed") return null;
    const fromMs = safeInteger(params.get(key(prefix, "from_ms")));
    const toMs = safeInteger(params.get(key(prefix, "to_ms")));
    const origin = params.get(key(prefix, "origin")) as FixedRangeOrigin | null;
    if (
      fromMs === null ||
      toMs === null ||
      !origin ||
      !origins.has(origin) ||
      validateResolvedTimeWindow({ fromMs, toMs }, config) !== null
    ) {
      return null;
    }
    const hasLast = params.has(key(prefix, "last_kind"));
    const parsedLastLiveSelection = hasLast
      ? parseLastLiveSelection(params, config, prefix)
      : undefined;
    if (hasLast && !parsedLastLiveSelection) return null;
    const lastLiveSelection = parsedLastLiveSelection ?? undefined;
    try {
      const fixed = createFixedRange(fromMs, toMs, origin, lastLiveSelection, timezone);
      return validateTimeRangeValue(fixed, nowMs, config) === null ? fixed : null;
    } catch {
      return null;
    }
  }
  const selection = parseLiveSelection(params, config, prefix);
  if (!selection) return null;
  let value: TimeRangeValue;
  if (selection.kind === "relative") {
    value = createRelativeRange(selection.durationMs, selection.presetId, timezone);
  } else if (selection.kind === "growing") {
    value = createGrowingRange(selection.fromMs, timezone);
  } else {
    value = createCalendarRange(selection.preset, timezone);
  }
  if (playback === "running")
    return validateTimeRangeValue(value, nowMs, config) === null ? value : null;
  if (playback !== "paused") return null;
  const fromMs = safeInteger(params.get(key(prefix, "from_ms")));
  const toMs = safeInteger(params.get(key(prefix, "to_ms")));
  if (
    fromMs === null ||
    toMs === null ||
    validateResolvedTimeWindow({ fromMs, toMs }, config) !== null
  ) {
    return null;
  }
  const paused: TimeRangeValue = {
    playback: { fromMs, kind: "paused", toMs },
    selection: value.selection,
    timezone,
  };
  return validateTimeRangeValue(paused, nowMs, config) === null ? paused : null;
}
