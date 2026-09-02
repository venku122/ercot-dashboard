import { describe, expect, it } from "vitest";

import {
  changeTimeRangeTimezone,
  createCalendarRange,
  createFixedRange,
  createGrowingRange,
  createRelativeRange,
  DEFAULT_TIME_RANGE_CONFIG,
  navigateTimeRange,
  parseWallTime,
  pauseTimeRange,
  resetTimeRange,
  resolveTimeRange,
  resolveWallTime,
  resumeTimeRange,
  selectRelativeRange,
  shiftInstantByCalendarDays,
  validateResolvedTimeWindow,
  validateTimeRangeValue,
  type TimeRangeConfig,
} from "./index";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const CHICAGO = "America/Chicago";
const config: TimeRangeConfig = {
  ...DEFAULT_TIME_RANGE_CONFIG,
  defaultTimezone: CHICAGO,
};

describe("semantic time range state machine", () => {
  it("TR-DOM-001/002/003 keeps relative semantics distinct while resolved time ticks", () => {
    const value = createRelativeRange(6 * HOUR, "past-6-hours");
    expect(value.selection).toEqual({
      durationMs: 6 * HOUR,
      kind: "relative",
      presetId: "past-6-hours",
    });
    expect(resolveTimeRange(value, 10 * HOUR, config)).toMatchObject({
      fromMs: 4 * HOUR,
      live: true,
      paused: false,
      toMs: 10 * HOUR,
    });
    expect(resolveTimeRange(value, 11 * HOUR, config)).toMatchObject({
      fromMs: 5 * HOUR,
      toMs: 11 * HOUR,
    });
    expect(value.selection.kind).toBe("relative");
  });

  it("TR-DOM-004/005/006 selects live from history and pauses/resumes at the new clock", () => {
    const original = createRelativeRange(6 * HOUR, "past-6-hours");
    const fixed = createFixedRange(HOUR, 7 * HOUR, "zoom", original.selection);
    const selected = selectRelativeRange(fixed, 24 * HOUR, "past-24-hours");
    expect(resolveTimeRange(selected, 100 * HOUR, config)).toMatchObject({
      fromMs: 76 * HOUR,
      toMs: 100 * HOUR,
      live: true,
    });

    const paused = pauseTimeRange(selected, 100 * HOUR, config);
    expect(resolveTimeRange(paused, 200 * HOUR, config)).toMatchObject({
      fromMs: 76 * HOUR,
      toMs: 100 * HOUR,
      paused: true,
    });
    const resumed = resumeTimeRange(paused);
    expect(resolveTimeRange(resumed, 200 * HOUR, config)).toMatchObject({
      fromMs: 176 * HOUR,
      toMs: 200 * HOUR,
      paused: false,
    });
  });

  it("TR-DOM-007/008/009/010 preserves fixed origin, duration, and last live reset", () => {
    const live = createRelativeRange(6 * HOUR, "past-6-hours");
    const zoom = createFixedRange(20 * HOUR, 22 * HOUR + 13 * MINUTE, "zoom", live.selection);
    expect(resolveTimeRange(zoom, 100 * HOUR, config)).toMatchObject({
      fromMs: 20 * HOUR,
      live: false,
      origin: "zoom",
      toMs: 22 * HOUR + 13 * MINUTE,
    });
    const previous = navigateTimeRange(zoom, -1, 100 * HOUR, config);
    const next = navigateTimeRange(previous, 1, 100 * HOUR, config);
    expect(next.selection).toMatchObject({
      fromMs: 20 * HOUR,
      kind: "fixed",
      origin: "navigation",
      toMs: 22 * HOUR + 13 * MINUTE,
    });
    expect(resolveTimeRange(resetTimeRange(next), 200 * HOUR, config)).toMatchObject({
      fromMs: 194 * HOUR,
      toMs: 200 * HOUR,
      live: true,
    });
  });

  it("TR-DOM-011 grows from a fixed instant and resumes growth after pause", () => {
    const growing = createGrowingRange(HOUR);
    const paused = pauseTimeRange(growing, 10 * HOUR, config);
    expect(resolveTimeRange(paused, 20 * HOUR, config)).toMatchObject({
      fromMs: HOUR,
      toMs: 10 * HOUR,
      paused: true,
    });
    expect(resolveTimeRange(resumeTimeRange(paused), 20 * HOUR, config)).toMatchObject({
      fromMs: HOUR,
      toMs: 20 * HOUR,
      live: true,
    });
  });

  it("TR-DOM-014 validates configurable duration limits", () => {
    expect(validateResolvedTimeWindow({ fromMs: 0, toMs: 4 * MINUTE }, config)).toEqual({
      code: "range_too_short",
      field: "range",
      message: "Time range must be at least 5 minutes.",
    });
    expect(validateResolvedTimeWindow({ fromMs: 0, toMs: 366 * DAY }, config)?.code).toBe(
      "range_too_long",
    );
    expect(validateResolvedTimeWindow({ fromMs: HOUR, toMs: HOUR }, config)?.code).toBe(
      "from_not_before_to",
    );
    expect(validateTimeRangeValue(createRelativeRange(MINUTE), 10 * HOUR, config)?.code).toBe(
      "range_too_short",
    );
  });
});

describe("IANA timezone and calendar semantics", () => {
  it("TR-TZ-006 rejects a nonexistent spring-forward wall time", () => {
    const parsed = parseWallTime("2026-03-08T02:30");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(resolveWallTime(parsed.parts, CHICAGO)).toEqual({ kind: "nonexistent" });
  });

  it("TR-TZ-007 exposes both fall-back occurrences", () => {
    const parsed = parseWallTime("2026-11-01T01:30");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = resolveWallTime(parsed.parts, CHICAGO);
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.laterMs - result.earlierMs).toBe(HOUR);
    expect(resolveWallTime(parsed.parts, CHICAGO, "earlier")).toEqual({
      instantMs: result.earlierMs,
      kind: "exact",
      occurrence: "earlier",
    });
    expect(resolveWallTime(parsed.parts, CHICAGO, "later")).toEqual({
      instantMs: result.laterMs,
      kind: "exact",
      occurrence: "later",
    });
  });

  it("TR-TZ-008 resolves spring and fall calendar days to 23 and 25 hours", () => {
    const springNow = Date.parse("2026-03-09T04:59:00-05:00");
    const fallNow = Date.parse("2026-11-02T04:59:00-06:00");
    const spring = resolveTimeRange(createCalendarRange("yesterday", CHICAGO), springNow, config);
    const fall = resolveTimeRange(createCalendarRange("yesterday", CHICAGO), fallNow, config);
    expect(spring.toMs - spring.fromMs).toBe(23 * HOUR);
    expect(fall.toMs - fall.fromMs).toBe(25 * HOUR);
  });

  it("TR-DOM-012 resolves the complete calendar preset set", () => {
    const now = Date.parse("2028-02-29T12:00:00-06:00");
    for (const preset of [
      "today",
      "yesterday",
      "week_to_date",
      "month_to_date",
      "previous_week",
      "previous_month",
      "year_to_date",
    ] as const) {
      const resolved = resolveTimeRange(createCalendarRange(preset, CHICAGO), now, config);
      expect(resolved.fromMs, preset).toBeLessThan(resolved.toMs);
    }
    expect(resolveTimeRange(createCalendarRange("today", CHICAGO), now, config).fromMs).toBe(
      Date.parse("2028-02-29T00:00:00-06:00"),
    );
  });

  it("TR-TZ-003/004/005 applies timezone changes according to semantic kind", () => {
    const now = Date.parse("2026-09-01T12:00:00Z");
    const fixed = createFixedRange(now - HOUR, now, "custom");
    expect(resolveTimeRange(changeTimeRangeTimezone(fixed, "UTC"), now, config)).toMatchObject({
      fromMs: now - HOUR,
      toMs: now,
    });
    const relative = createRelativeRange(HOUR);
    expect(resolveTimeRange(changeTimeRangeTimezone(relative, "UTC"), now, config)).toMatchObject({
      fromMs: now - HOUR,
      toMs: now,
    });
    const chicagoToday = resolveTimeRange(createCalendarRange("today", CHICAGO), now, config);
    const utcToday = resolveTimeRange(
      changeTimeRangeTimezone(createCalendarRange("today", CHICAGO), "UTC"),
      now,
      config,
    );
    expect(utcToday.fromMs).not.toBe(chicagoToday.fromMs);
  });

  it("TR-TZ-009 shifts the same local clock by calendar days across DST", () => {
    const before = Date.parse("2026-03-07T12:00:00-06:00");
    const after = shiftInstantByCalendarDays(before, 1, CHICAGO);
    expect(after).toBe(Date.parse("2026-03-08T12:00:00-05:00"));
    expect(after - before).toBe(23 * HOUR);
  });
});
