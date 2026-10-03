import { describe, expect, it } from "vitest";

import {
  decodeTimeRange,
  encodeTimeRange,
  formatTimeRangeExpression,
  incrementTimeRangeExpression,
  parseTimeRangeExpression,
  resolveTimeRange,
  type TimeRangeConfig,
} from "./index";

const NOW = Date.parse("2026-09-03T04:00:00Z");
const CHICAGO = "America/Chicago";
const config: TimeRangeConfig = {
  defaultRelativeRange: { durationMs: 6 * 3_600_000, presetId: "past-6-hours" },
  defaultTimezone: CHICAGO,
  locale: "en-US",
  maxDurationMs: 5_000 * 86_400_000,
  minDurationMs: 5 * 60_000,
};

function parse(expression: string, timezone = CHICAGO) {
  return parseTimeRangeExpression(expression, { config, nowMs: NOW, timezone });
}

describe("Datadog Custom Time Frames expression contract", () => {
  it.each([
    ["5m", 5 * 60_000],
    ["15 mins", 15 * 60_000],
    ["15 min", 15 * 60_000],
    ["5 minute", 5 * 60_000],
    ["5 minutes", 5 * 60_000],
    ["4h", 4 * 3_600_000],
    ["12 hrs", 12 * 3_600_000],
    ["12 hr", 12 * 3_600_000],
    ["1 hour", 3_600_000],
    ["2d", 2 * 86_400_000],
    ["1 day", 86_400_000],
    ["2 days", 2 * 86_400_000],
    ["2 weeks", 14 * 86_400_000],
    ["2w", 14 * 86_400_000],
    ["1 week", 7 * 86_400_000],
    ["3 months", 90 * 86_400_000],
    ["3mo", 90 * 86_400_000],
    ["3 mos", 90 * 86_400_000],
    ["3 mon", 90 * 86_400_000],
    ["3 mons", 90 * 86_400_000],
    ["1 month", 30 * 86_400_000],
    ["Past 1 Hour", 3_600_000],
  ])("DD-SYN-003 parses %s as a sliding range", (expression, durationMs) => {
    const result = parse(expression);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.selection).toMatchObject({ durationMs, kind: "relative" });
    expect(resolveTimeRange(result.value, NOW, config)).toMatchObject({
      fromMs: NOW - durationMs,
      live: true,
      toMs: NOW,
    });
  });

  it.each(["Jan 1 - Jan 2", "1/1/19 - 1/2/19", "1-1-2019 - 1-2-2019"])(
    "DD-SYN-001/002 parses fixed date range %s",
    (expression) => {
      const result = parse(expression);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.selection.kind).toBe("fixed");
      const window = resolveTimeRange(result.value, NOW, config);
      expect(window.toMs - window.fromMs).toBe(2 * 86_400_000);
    },
  );

  it("parses named time, time-only rollover, and Unix seconds/milliseconds", () => {
    const named = parse("Jan 1, 2019, 1:00 pm - Jan 1, 2019, 2:00 pm");
    const overnight = parse("11:00 pm - 1:00 am");
    const unix = parse("1577883600 - 1578009540000", "UTC");
    expect(
      named.ok &&
        resolveTimeRange(named.value, NOW, config).toMs -
          resolveTimeRange(named.value, NOW, config).fromMs,
    ).toBe(3_600_000);
    expect(
      overnight.ok &&
        resolveTimeRange(overnight.value, NOW, config).toMs -
          resolveTimeRange(overnight.value, NOW, config).fromMs,
    ).toBe(2 * 3_600_000);
    expect(unix.ok).toBe(true);
  });

  it.each(["Jan 1 to now", "Jan 1 - now", "since Jun 1", "from 5h", "since 1549116000"])(
    "DD-SYN-004 parses growing form %s",
    (expression) => {
      const result = parse(expression);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.selection.kind).toBe("growing");
      expect(resolveTimeRange(result.value, NOW, config).live).toBe(true);
    },
  );

  it.each([
    ["today", "calendar", "today"],
    ["this day", "calendar", "today"],
    ["yesterday", "calendar", "yesterday"],
    ["last day", "calendar", "yesterday"],
    ["previous day", "calendar", "yesterday"],
    ["week to date", "calendar", "week_to_date"],
    ["this week", "calendar", "week_to_date"],
    ["month to date", "calendar", "month_to_date"],
    ["this month", "calendar", "month_to_date"],
    ["year to date", "calendar", "year_to_date"],
    ["this year", "calendar", "year_to_date"],
    ["last week", "calendar", "previous_week"],
    ["previous week", "calendar", "previous_week"],
    ["last month", "calendar", "previous_month"],
    ["previous month", "calendar", "previous_month"],
    ["2 weeks ago", "fixed", undefined],
    ["3 months ago", "fixed", undefined],
    ["last year", "fixed", undefined],
    ["previous year", "fixed", undefined],
  ])("DD-SYN-005 parses calendar phrase %s", (expression, kind, preset) => {
    const result = parse(expression);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.selection.kind).toBe(kind);
    if (preset) expect(result.value.selection).toMatchObject({ preset });
  });

  it("DD-SYN-007 is case/whitespace tolerant and accepts the documented en dash", () => {
    expect(parse("  PAST   1   HOUR  ").ok).toBe(true);
    expect(parse("Jan 1, 2026 – Jan 2, 2026").ok).toBe(true);
  });

  it("rejects DST gaps and exposes overlap recovery", () => {
    const gap = parseTimeRangeExpression("Mar 8, 2026, 2:30 am - Mar 8, 2026, 4:30 am", {
      config,
      nowMs: NOW,
      timezone: CHICAGO,
    });
    const overlap = parseTimeRangeExpression("Nov 1, 2026, 1:30 am - Nov 1, 2026, 3:30 am", {
      config,
      nowMs: NOW,
      timezone: CHICAGO,
    });
    expect(gap).toMatchObject({ code: "nonexistent_wall_time", ok: false });
    expect(overlap).toMatchObject({ code: "ambiguous_wall_time", ok: false });
  });

  it("DD-SYN-006 increments selected month, day, year, hour, and minute tokens", () => {
    const expression = "Jan 1, 2026, 1:05 pm - Jan 2, 2026, 2:10 pm";
    const cases = [
      [0, 3, "Feb"],
      [4, 5, "2"],
      [7, 11, "2027"],
      [13, 14, "2"],
      [15, 17, "06"],
    ] as const;
    for (const [start, end, expected] of cases) {
      const result = incrementTimeRangeExpression(expression, start, end, 1);
      expect(result?.expression.slice(result.selectionStart, result.selectionEnd)).toBe(expected);
    }
  });

  it("DD-SYN-008 aliases normalize and values round trip through the semantic URL codec", () => {
    const aliases = [parse("60m"), parse("1 hour"), parse("Past 1 Hour")];
    expect(aliases.every((result) => result.ok)).toBe(true);
    const values = aliases.flatMap((result) => (result.ok ? [result.value] : []));
    expect(values.map((value) => resolveTimeRange(value, NOW, config))).toEqual([
      resolveTimeRange(values[0]!, NOW, config),
      resolveTimeRange(values[0]!, NOW, config),
      resolveTimeRange(values[0]!, NOW, config),
    ]);
    for (const value of values) {
      expect(decodeTimeRange(encodeTimeRange(value), config, NOW)).toEqual(value);
      expect(formatTimeRangeExpression(value, NOW, config)).toBe("Past 1 Hour");
    }
  });

  it("enforces configured duration bounds without committing malformed text", () => {
    const short = parse("1m");
    const long = parse("6000 days");
    const malformed = parse("sometime after lunch");
    expect(short).toMatchObject({ code: "range_too_short", ok: false });
    expect(long).toMatchObject({ code: "range_too_long", ok: false });
    expect(malformed).toMatchObject({ code: "invalid_expression", ok: false });
  });

  it.each([
    "Jan 2, 2026 - Jan 1, 2026",
    "Jan 2, 2026, 2:00 pm - Jan 2, 2026, 1:00 pm",
    "1578009540000 - 1577883600000",
  ])("rejects reversed explicit range %s instead of inventing rollover", (expression) => {
    expect(parse(expression)).toMatchObject({ code: "from_not_before_to", ok: false });
  });

  it("keeps canonical editable syntax parser-round-trippable for non-English consumers", () => {
    const localConfig = { ...config, locale: "fr-CA" };
    const value = parse("Jan 1, 2026, 1:00 pm - Jan 1, 2026, 2:00 pm");
    expect(value.ok).toBe(true);
    if (!value.ok) return;
    const formatted = formatTimeRangeExpression(value.value, NOW, localConfig);
    expect(
      parseTimeRangeExpression(formatted, { config: localConfig, nowMs: NOW, timezone: CHICAGO })
        .ok,
    ).toBe(true);
  });
});
