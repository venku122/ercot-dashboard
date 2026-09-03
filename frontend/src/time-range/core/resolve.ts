import { exactInstantForWallParts, shiftWallDate, wallPartsAt } from "./timezone";
import type {
  CalendarPresetId,
  LiveTimeRangeSpec,
  ResolvedTimeWindow,
  TimeRangeConfig,
  TimeRangeValue,
  WallTimeParts,
} from "./types";

function midnight(parts: WallTimeParts): WallTimeParts {
  return { ...parts, hour: 0, millisecond: 0, minute: 0, second: 0 };
}

function firstOfMonth(parts: WallTimeParts): WallTimeParts {
  return { ...midnight(parts), day: 1 };
}

function firstOfYear(parts: WallTimeParts): WallTimeParts {
  return { ...midnight(parts), day: 1, month: 1 };
}

function startOfWeek(parts: WallTimeParts): WallTimeParts {
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return shiftWallDate(midnight(parts), -((day + 6) % 7));
}

function previousMonthStart(parts: WallTimeParts): WallTimeParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 2, 1));
  return {
    day: 1,
    hour: 0,
    millisecond: 0,
    minute: 0,
    month: date.getUTCMonth() + 1,
    second: 0,
    year: date.getUTCFullYear(),
  };
}

function resolveCalendar(
  preset: CalendarPresetId,
  nowMs: number,
  timezone: string,
): { fromMs: number; live: boolean; toMs: number } {
  const current = wallPartsAt(nowMs, timezone);
  const today = midnight(current);
  let from: WallTimeParts;
  let to: WallTimeParts | null = null;
  let live = false;
  switch (preset) {
    case "today":
      from = today;
      live = true;
      break;
    case "yesterday":
      from = shiftWallDate(today, -1);
      to = today;
      break;
    case "week_to_date":
      from = startOfWeek(current);
      live = true;
      break;
    case "month_to_date":
      from = firstOfMonth(current);
      live = true;
      break;
    case "previous_week": {
      const thisWeek = startOfWeek(current);
      from = shiftWallDate(thisWeek, -7);
      to = thisWeek;
      break;
    }
    case "previous_month":
      from = previousMonthStart(current);
      to = firstOfMonth(current);
      break;
    case "year_to_date":
      from = firstOfYear(current);
      live = true;
      break;
  }
  return {
    fromMs: exactInstantForWallParts(from, timezone),
    live,
    toMs: to ? exactInstantForWallParts(to, timezone) : nowMs,
  };
}

export function isLiveCapableSelection(selection: LiveTimeRangeSpec): boolean {
  return (
    selection.kind !== "calendar" ||
    ["today", "week_to_date", "month_to_date", "year_to_date"].includes(selection.preset)
  );
}

export function resolveTimeRange(
  value: TimeRangeValue,
  nowMs: number,
  config: TimeRangeConfig,
): ResolvedTimeWindow {
  const timezone = value.timezone || config.defaultTimezone;
  if (value.playback.kind === "paused") {
    return {
      fromMs: value.playback.fromMs,
      live: false,
      paused: true,
      timezone,
      toMs: value.playback.toMs,
    };
  }
  if (value.selection.kind === "fixed") {
    return {
      fromMs: value.selection.fromMs,
      live: false,
      origin: value.selection.origin,
      paused: false,
      timezone,
      toMs: value.selection.toMs,
    };
  }
  if (value.selection.kind === "relative") {
    return {
      fromMs: nowMs - value.selection.durationMs,
      live: true,
      paused: false,
      timezone,
      toMs: nowMs,
    };
  }
  if (value.selection.kind === "growing") {
    return {
      fromMs: value.selection.fromMs,
      live: true,
      paused: false,
      timezone,
      toMs: nowMs,
    };
  }
  const calendar = resolveCalendar(value.selection.preset, nowMs, timezone);
  return { ...calendar, paused: false, timezone };
}
