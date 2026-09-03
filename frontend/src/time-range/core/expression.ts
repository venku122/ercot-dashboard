import { formatDuration } from "./format";
import { resolveTimeRange } from "./resolve";
import {
  commitFixedTimeRange,
  createCalendarRange,
  createFixedRange,
  createGrowingRange,
  createRelativeRange,
} from "./transitions";
import { exactInstantForWallParts, resolveWallTime, shiftWallDate, wallPartsAt } from "./timezone";
import type {
  CalendarPresetId,
  TimeRangeConfig,
  TimeRangeValidationError,
  TimeRangeValue,
  WallTimeOccurrence,
  WallTimeParts,
} from "./types";
import { validateTimeRangeValue } from "./validate";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const MONTH_LOOKUP = new Map(
  MONTHS.flatMap((month, index) => [
    [month.toLowerCase(), index + 1] as const,
    [month.slice(0, 3).toLowerCase(), index + 1] as const,
  ]),
);
const UNIT_MS = {
  day: 86_400_000,
  hour: 3_600_000,
  minute: 60_000,
  month: 30 * 86_400_000,
  week: 7 * 86_400_000,
} as const;

export type TimeRangeExpressionErrorCode =
  | "ambiguous_wall_time"
  | "from_not_before_to"
  | "invalid_expression"
  | "nonexistent_wall_time"
  | "range_too_long"
  | "range_too_short";

export type TimeRangeExpressionSegment = {
  end: number;
  kind: "day" | "hour" | "minute" | "month" | "year";
  start: number;
};

export type ParseTimeRangeExpressionOptions = {
  config: TimeRangeConfig;
  nowMs: number;
  occurrence?: WallTimeOccurrence;
  referenceValue?: TimeRangeValue;
  timezone: string;
};

export type ParseTimeRangeExpressionResult =
  | {
      canonicalExpression: string;
      ok: true;
      segments: readonly TimeRangeExpressionSegment[];
      value: TimeRangeValue;
    }
  | {
      code: TimeRangeExpressionErrorCode;
      field?: "from" | "range" | "to";
      message: string;
      ok: false;
      validationError?: TimeRangeValidationError;
    };

type ParsedInstant = {
  dateOnly: boolean;
  instantMs: number;
  timeOnly: boolean;
  yearExplicit: boolean;
};

type ExpressionFailure = { code: TimeRangeExpressionErrorCode; message: string };

function failure(
  code: TimeRangeExpressionErrorCode,
  message: string,
  field?: "from" | "range" | "to",
  validationError?: TimeRangeValidationError,
): ParseTimeRangeExpressionResult {
  return {
    code,
    ...(field ? { field } : {}),
    message,
    ok: false,
    ...(validationError ? { validationError } : {}),
  };
}

function normalizeYear(value: number): number {
  if (value >= 100) return value;
  return value >= 69 ? 1900 + value : 2000 + value;
}

function normalizeUnit(raw: string): keyof typeof UNIT_MS | null {
  const value = raw.toLowerCase();
  if (["m", "min", "mins", "minute", "minutes"].includes(value)) return "minute";
  if (["h", "hr", "hrs", "hour", "hours"].includes(value)) return "hour";
  if (["d", "day", "days"].includes(value)) return "day";
  if (["w", "week", "weeks"].includes(value)) return "week";
  if (["mo", "mos", "mon", "mons", "month", "months"].includes(value)) return "month";
  return null;
}

function parts(base: WallTimeParts, values: Partial<WallTimeParts>): WallTimeParts {
  return {
    day: values.day ?? base.day,
    hour: values.hour ?? 0,
    millisecond: values.millisecond ?? 0,
    minute: values.minute ?? 0,
    month: values.month ?? base.month,
    second: values.second ?? 0,
    year: values.year ?? base.year,
  };
}

function resolveParts(
  value: WallTimeParts,
  timezone: string,
  occurrence?: WallTimeOccurrence,
): ParsedInstant | ExpressionFailure {
  const result = resolveWallTime(value, timezone, occurrence);
  if (result.kind === "nonexistent") {
    return {
      code: "nonexistent_wall_time",
      message: "That local time does not exist because of a daylight-saving transition.",
    };
  }
  if (result.kind === "ambiguous") {
    return {
      code: "ambiguous_wall_time",
      message: "Choose the earlier or later occurrence of this local time.",
    };
  }
  return { dateOnly: false, instantMs: result.instantMs, timeOnly: false, yearExplicit: true };
}

function parseClock(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(value.trim());
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const meridiem = match[3]!.toLowerCase();
  if (hour === 12) hour = 0;
  if (meridiem === "pm") hour += 12;
  return { hour, minute };
}

function parseFixedInstant(
  source: string,
  nowMs: number,
  timezone: string,
  occurrence?: WallTimeOccurrence,
): ParsedInstant | ExpressionFailure {
  const value = source.trim().replaceAll(/\s+/g, " ");
  if (/^\d{10}$/.test(value)) {
    return {
      dateOnly: false,
      instantMs: Number(value) * 1000,
      timeOnly: false,
      yearExplicit: true,
    };
  }
  if (/^\d{13}$/.test(value)) {
    return { dateOnly: false, instantMs: Number(value), timeOnly: false, yearExplicit: true };
  }
  const base = wallPartsAt(nowMs, timezone);
  const clockOnly = parseClock(value);
  if (clockOnly) {
    const resolved = resolveParts(parts(base, clockOnly), timezone, occurrence);
    return "code" in resolved
      ? resolved
      : { ...resolved, dateOnly: false, timeOnly: true, yearExplicit: false };
  }

  const named =
    /^([a-z]+)\s+(\d{1,2})(?:,?\s+(\d{2}|\d{4}))?(?:,?\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)))?$/i.exec(
      value,
    );
  const numeric =
    /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?(?:,?\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)))?$/i.exec(
      value,
    );
  const month = named ? MONTH_LOOKUP.get(named[1]!.toLowerCase()) : Number(numeric?.[1]);
  const day = Number(named?.[2] ?? numeric?.[2]);
  const yearText = named?.[3] ?? numeric?.[3];
  const clockText = named?.[4] ?? numeric?.[4];
  if (!month || month > 12 || !day || day > 31 || (!named && !numeric)) {
    return { code: "invalid_expression", message: "Enter a supported time range." };
  }
  const clock = clockText ? parseClock(clockText) : null;
  if (clockText && !clock) {
    return { code: "invalid_expression", message: "Enter a valid 12-hour time." };
  }
  const clockValues = clock ? { hour: clock.hour, minute: clock.minute } : {};
  const candidate = parts(base, {
    day,
    month,
    year: yearText ? normalizeYear(Number(yearText)) : base.year,
    ...clockValues,
  });
  const normalized = new Date(
    Date.UTC(candidate.year, candidate.month - 1, candidate.day, candidate.hour, candidate.minute),
  );
  if (
    normalized.getUTCFullYear() !== candidate.year ||
    normalized.getUTCMonth() + 1 !== candidate.month ||
    normalized.getUTCDate() !== candidate.day
  ) {
    return { code: "invalid_expression", message: "Enter a valid calendar date." };
  }
  const resolved = resolveParts(candidate, timezone, occurrence);
  return "code" in resolved
    ? resolved
    : {
        ...resolved,
        dateOnly: !clock,
        timeOnly: false,
        yearExplicit: Boolean(yearText),
      };
}

function startOfWeek(value: WallTimeParts): WallTimeParts {
  const weekday = new Date(Date.UTC(value.year, value.month - 1, value.day)).getUTCDay();
  return shiftWallDate(
    { ...value, hour: 0, millisecond: 0, minute: 0, second: 0 },
    -((weekday + 6) % 7),
  );
}

function shiftMonth(value: WallTimeParts, months: number): WallTimeParts {
  const date = new Date(Date.UTC(value.year, value.month - 1 + months, 1));
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

function fixedValue(
  fromMs: number,
  toMs: number,
  options: ParseTimeRangeExpressionOptions,
): TimeRangeValue {
  return options.referenceValue
    ? commitFixedTimeRange(options.referenceValue, fromMs, toMs, "custom", options.timezone)
    : createFixedRange(fromMs, toMs, "custom", undefined, options.timezone);
}

function calendarFixed(
  amount: number,
  unit: "day" | "month" | "week" | "year",
  options: ParseTimeRangeExpressionOptions,
): TimeRangeValue {
  const current = wallPartsAt(options.nowMs, options.timezone);
  const today = { ...current, hour: 0, millisecond: 0, minute: 0, second: 0 };
  let from: WallTimeParts;
  let to: WallTimeParts;
  if (unit === "day") {
    from = shiftWallDate(today, -amount);
    to = shiftWallDate(from, 1);
  } else if (unit === "week") {
    to = shiftWallDate(startOfWeek(current), -(amount - 1) * 7);
    from = shiftWallDate(to, -7);
  } else if (unit === "month") {
    to = shiftMonth(current, -(amount - 1));
    from = shiftMonth(to, -1);
  } else {
    to = { ...today, day: 1, month: 1, year: current.year - amount + 1 };
    from = { ...to, year: to.year - 1 };
  }
  return fixedValue(
    exactInstantForWallParts(from, options.timezone),
    exactInstantForWallParts(to, options.timezone),
    options,
  );
}

function calendarValue(
  normalized: string,
  options: ParseTimeRangeExpressionOptions,
): TimeRangeValue | null {
  const aliases = new Map<string, CalendarPresetId>([
    ["today", "today"],
    ["this day", "today"],
    ["yesterday", "yesterday"],
    ["last day", "yesterday"],
    ["previous day", "yesterday"],
    ["week to date", "week_to_date"],
    ["this week", "week_to_date"],
    ["month to date", "month_to_date"],
    ["this month", "month_to_date"],
    ["year to date", "year_to_date"],
    ["this year", "year_to_date"],
    ["last week", "previous_week"],
    ["previous week", "previous_week"],
    ["last month", "previous_month"],
    ["previous month", "previous_month"],
  ]);
  const preset = aliases.get(normalized);
  if (preset) return createCalendarRange(preset, options.timezone);
  if (["last year", "previous year"].includes(normalized)) {
    return calendarFixed(1, "year", options);
  }
  const ago = /^(\d+)\s+(days?|weeks?|months?|years?)\s+ago$/.exec(normalized);
  if (!ago) return null;
  const singular = ago[2]!.replace(/s$/, "") as "day" | "month" | "week" | "year";
  return calendarFixed(Number(ago[1]), singular, options);
}

function expressionSegments(expression: string): readonly TimeRangeExpressionSegment[] {
  const segments: TimeRangeExpressionSegment[] = [];
  for (const match of expression.matchAll(
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi,
  )) {
    segments.push({ end: match.index + match[0].length, kind: "month", start: match.index });
  }
  for (const match of expression.matchAll(/\b\d{4}\b/g)) {
    segments.push({ end: match.index + 4, kind: "year", start: match.index });
  }
  for (const match of expression.matchAll(
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})\b/gi,
  )) {
    const token = match[1]!;
    const start = match.index + match[0].lastIndexOf(token);
    segments.push({ end: start + token.length, kind: "day", start });
  }
  for (const match of expression.matchAll(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?/g)) {
    const monthToken = match[1]!;
    const dayToken = match[2]!;
    const monthStart = match.index;
    const dayStart = match.index + monthToken.length + 1;
    segments.push({ end: monthStart + monthToken.length, kind: "month", start: monthStart });
    segments.push({ end: dayStart + dayToken.length, kind: "day", start: dayStart });
    if (match[3]) {
      const yearStart = dayStart + dayToken.length + 1;
      segments.push({ end: yearStart + match[3].length, kind: "year", start: yearStart });
    }
  }
  for (const match of expression.matchAll(/\b(\d{1,2}):(\d{2})\s*(?:am|pm)\b/gi)) {
    const hourStart = match.index;
    const minuteStart = match.index + match[1]!.length + 1;
    segments.push({ end: hourStart + match[1]!.length, kind: "hour", start: hourStart });
    segments.push({ end: minuteStart + 2, kind: "minute", start: minuteStart });
  }
  return [
    ...new Map(segments.map((segment) => [`${segment.start}:${segment.end}`, segment])).values(),
  ].sort((left, right) => left.start - right.start);
}

function validationFailure(value: TimeRangeValue, options: ParseTimeRangeExpressionOptions) {
  const validation = validateTimeRangeValue(value, options.nowMs, options.config);
  if (!validation) return null;
  const code =
    validation.code === "range_too_short"
      ? "range_too_short"
      : validation.code === "range_too_long"
        ? "range_too_long"
        : "invalid_expression";
  return failure(code, validation.message, validation.field, validation);
}

function parseTimeRangeExpressionInternal(
  expression: string,
  options: ParseTimeRangeExpressionOptions,
): ParseTimeRangeExpressionResult {
  const source = expression.trim().replaceAll(/\s+/g, " ");
  const normalized = source.toLowerCase();
  if (!source) return failure("invalid_expression", "Enter a time range.");

  const calendar = calendarValue(normalized, options);
  if (calendar) {
    const invalid = validationFailure(calendar, options);
    return (
      invalid ?? {
        canonicalExpression: formatTimeRangeExpression(calendar, options.nowMs, options.config),
        ok: true,
        segments: expressionSegments(source),
        value: calendar,
      }
    );
  }

  const relative = /^(?:past\s+)?(\d+)\s*([a-z]+)$/.exec(normalized);
  if (relative) {
    const unit = normalizeUnit(relative[2]!);
    if (unit) {
      const durationMs = Number(relative[1]) * UNIT_MS[unit];
      const presetId =
        options.referenceValue?.selection.kind === "relative" &&
        options.referenceValue.selection.durationMs === durationMs
          ? options.referenceValue.selection.presetId
          : undefined;
      const value = createRelativeRange(durationMs, presetId, options.timezone);
      const invalid = validationFailure(value, options);
      return (
        invalid ?? {
          canonicalExpression: formatTimeRangeExpression(value, options.nowMs, options.config),
          ok: true,
          segments: expressionSegments(source),
          value,
        }
      );
    }
  }

  const growing =
    /^(?:since\s+|from\s+)(.+)$/i.exec(source) ?? /^(.*?)\s+(?:to|-|–)\s+now$/i.exec(source);
  if (growing) {
    const startSource = growing[1]!.trim();
    const relativeStart = /^(\d+)\s*([a-z]+)$/.exec(startSource.toLowerCase());
    let fromMs: number;
    if (relativeStart) {
      const unit = normalizeUnit(relativeStart[2]!);
      if (!unit) return failure("invalid_expression", "Enter a supported growing range.");
      fromMs = options.nowMs - Number(relativeStart[1]) * UNIT_MS[unit];
    } else {
      const parsed = parseFixedInstant(
        startSource,
        options.nowMs,
        options.timezone,
        options.occurrence,
      );
      if ("code" in parsed) return failure(parsed.code, parsed.message, "from");
      fromMs = parsed.instantMs;
    }
    const value = createGrowingRange(fromMs, options.timezone);
    const invalid = validationFailure(value, options);
    return (
      invalid ?? {
        canonicalExpression: formatTimeRangeExpression(value, options.nowMs, options.config),
        ok: true,
        segments: expressionSegments(source),
        value,
      }
    );
  }

  const range = /^(.*?)\s+(?:-|–)\s+(.*?)$/.exec(source);
  if (range) {
    const from = parseFixedInstant(range[1]!, options.nowMs, options.timezone, options.occurrence);
    if ("code" in from) return failure(from.code, from.message, "from");
    const to = parseFixedInstant(range[2]!, options.nowMs, options.timezone, options.occurrence);
    if ("code" in to) return failure(to.code, to.message, "to");
    let toMs = to.instantMs;
    if (to.dateOnly)
      toMs = exactInstantForWallParts(
        shiftWallDate(wallPartsAt(toMs, options.timezone), 1),
        options.timezone,
      );
    if (toMs <= from.instantMs && from.timeOnly && to.timeOnly) {
      toMs = exactInstantForWallParts(
        shiftWallDate(wallPartsAt(toMs, options.timezone), 1),
        options.timezone,
      );
    } else if (toMs <= from.instantMs && !to.yearExplicit && !to.timeOnly) {
      const endParts = wallPartsAt(toMs, options.timezone);
      toMs = exactInstantForWallParts({ ...endParts, year: endParts.year + 1 }, options.timezone);
    }
    if (toMs <= from.instantMs) {
      return failure("from_not_before_to", "The start must be earlier than the end.");
    }
    const value = fixedValue(from.instantMs, toMs, options);
    const invalid = validationFailure(value, options);
    return (
      invalid ?? {
        canonicalExpression: formatTimeRangeExpression(value, options.nowMs, options.config),
        ok: true,
        segments: expressionSegments(source),
        value,
      }
    );
  }

  const single = parseFixedInstant(source, options.nowMs, options.timezone, options.occurrence);
  if (!("code" in single) && single.dateOnly) {
    const toMs = exactInstantForWallParts(
      shiftWallDate(wallPartsAt(single.instantMs, options.timezone), 1),
      options.timezone,
    );
    const value = fixedValue(single.instantMs, toMs, options);
    const invalid = validationFailure(value, options);
    return (
      invalid ?? {
        canonicalExpression: formatTimeRangeExpression(value, options.nowMs, options.config),
        ok: true,
        segments: expressionSegments(source),
        value,
      }
    );
  }
  return failure("invalid_expression", "Enter a supported Datadog time range.");
}

export function parseTimeRangeExpression(
  expression: string,
  options: ParseTimeRangeExpressionOptions,
): ParseTimeRangeExpressionResult {
  try {
    return parseTimeRangeExpressionInternal(expression, options);
  } catch {
    return failure("invalid_expression", "Enter a supported time range.");
  }
}

function prettyDuration(durationMs: number): string {
  const units = [
    [30 * UNIT_MS.day, "Month"],
    [UNIT_MS.week, "Week"],
    [UNIT_MS.day, "Day"],
    [UNIT_MS.hour, "Hour"],
    [UNIT_MS.minute, "Minute"],
  ] as const;
  for (const [size, label] of units) {
    if (durationMs % size === 0) {
      const amount = durationMs / size;
      return `${String(amount)} ${label}${amount === 1 ? "" : "s"}`;
    }
  }
  return formatDuration(durationMs);
}

function formatEndpoint(instantMs: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZone: timezone,
    year: "numeric",
  }).format(instantMs);
}

export function formatTimeRangeExpression(
  value: TimeRangeValue,
  nowMs: number,
  config: TimeRangeConfig,
): string {
  if (value.playback.kind === "paused" || value.selection.kind === "fixed") {
    const resolved = resolveTimeRange(value, nowMs, config);
    return `${formatEndpoint(resolved.fromMs, value.timezone)} – ${formatEndpoint(resolved.toMs, value.timezone)}`;
  }
  if (value.selection.kind === "relative")
    return `Past ${prettyDuration(value.selection.durationMs)}`;
  if (value.selection.kind === "growing") {
    return `Since ${formatEndpoint(value.selection.fromMs, value.timezone)}`;
  }
  const labels: Record<CalendarPresetId, string> = {
    month_to_date: "Month to date",
    previous_month: "Previous month",
    previous_week: "Previous week",
    today: "Today",
    week_to_date: "Week to date",
    year_to_date: "Year to date",
    yesterday: "Yesterday",
  };
  return labels[value.selection.preset];
}

export function formatTimeRangePill(
  value: TimeRangeValue,
  nowMs: number,
  config: TimeRangeConfig,
): string {
  const resolved = resolveTimeRange(value, nowMs, config);
  return formatDuration(resolved.toMs - resolved.fromMs).replaceAll(" ", "");
}

export function incrementTimeRangeExpression(
  expression: string,
  selectionStart: number,
  selectionEnd: number,
  direction: -1 | 1,
): { expression: string; selectionEnd: number; selectionStart: number } | null {
  const segments = expressionSegments(expression);
  const segment = segments.find(
    (candidate) => candidate.start < selectionEnd && candidate.end > selectionStart,
  );
  if (!segment) return null;
  const token = expression.slice(segment.start, segment.end);
  let replacement: string;
  if (segment.kind === "month") {
    const numeric = /^\d+$/.test(token);
    const current = numeric ? Number(token) : MONTH_LOOKUP.get(token.toLowerCase());
    if (!current || current > 12) return null;
    const next = ((current - 1 + direction + 12) % 12) + 1;
    replacement = numeric
      ? String(next).padStart(token.length, "0")
      : MONTHS[next - 1]!.slice(0, token.length <= 3 ? 3 : undefined);
  } else {
    const current = Number(token);
    if (!Number.isFinite(current)) return null;
    const minimum = segment.kind === "hour" ? 1 : segment.kind === "minute" ? 0 : 1;
    const maximum =
      segment.kind === "hour"
        ? 12
        : segment.kind === "minute"
          ? 59
          : segment.kind === "day"
            ? 31
            : 9999;
    const next = Math.min(maximum, Math.max(minimum, current + direction));
    replacement = String(next).padStart(token.length, "0");
  }
  return {
    expression: `${expression.slice(0, segment.start)}${replacement}${expression.slice(segment.end)}`,
    selectionEnd: segment.start + replacement.length,
    selectionStart: segment.start,
  };
}
