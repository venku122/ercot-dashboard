import { describe, expect, it } from "vitest";

import {
  createCalendarRange,
  createFixedRange,
  createGrowingRange,
  createRelativeRange,
  decodeTimeRange,
  encodeTimeRange,
  pauseTimeRange,
  type TimeRangeConfig,
} from "./index";

const HOUR = 3_600_000;
const nowMs = Date.parse("2026-09-01T18:00:00Z");
const config: TimeRangeConfig = {
  defaultTimezone: "America/Chicago",
  locale: "en-US",
  maxDurationMs: 365 * 24 * HOUR,
  minDurationMs: 5 * 60_000,
};

describe("semantic time URL codec", () => {
  it("TR-URL-001/003/004 round trips relative, growing, and calendar meaning", () => {
    for (const value of [
      createRelativeRange(6 * HOUR, "past-6-hours", "America/Chicago"),
      createGrowingRange(nowMs - 2 * HOUR, "UTC"),
      createCalendarRange("week_to_date", "America/New_York"),
    ]) {
      const params = encodeTimeRange(value, new URLSearchParams("view=overview&events=1"));
      expect(decodeTimeRange(params, config, nowMs)).toEqual(value);
      expect(params.get("view")).toBe("overview");
      expect(params.get("events")).toBe("1");
    }
  });

  it("TR-URL-002 round trips fixed instants and reset-live memory exactly", () => {
    const live = createRelativeRange(24 * HOUR, "past-24-hours", "America/Chicago");
    const fixed = createFixedRange(
      nowMs - 2 * HOUR - 13 * 60_000 - 321,
      nowMs - 321,
      "zoom",
      { selection: live.selection, timezone: live.timezone },
      "America/Chicago",
    );
    expect(decodeTimeRange(encodeTimeRange(fixed), config, nowMs)).toEqual(fixed);
  });

  it("TR-URL-005 round trips a paused semantic selection and frozen endpoints", () => {
    const paused = pauseTimeRange(createCalendarRange("today", "America/Chicago"), nowMs, config);
    expect(decodeTimeRange(encodeTimeRange(paused), config, nowMs + HOUR)).toEqual(paused);
  });

  it("TR-URL-008 preserves unrelated parameters while replacing owned time fields", () => {
    const params = new URLSearchParams(
      "view=market&compare=day&history=1&legend=compact&inspect=storage&hidden=a&time_kind=fixed&time_value=stale",
    );
    const encoded = encodeTimeRange(createRelativeRange(HOUR, "past-hour", "UTC"), params);
    expect(encoded.get("time_kind")).toBe("relative");
    for (const key of ["view", "compare", "history", "legend", "inspect", "hidden"]) {
      expect(encoded.get(key), key).toBe(params.get(key));
    }
  });

  it("TR-URL-009 rejects malicious, huge, negative, and incomplete inputs", () => {
    for (const query of [
      "time_kind=relative&time_value=-1&time_tz=UTC&time_play=running",
      "time_kind=relative&time_value=Infinity&time_tz=UTC&time_play=running",
      "time_kind=relative&time_value=999999999999999&time_tz=UTC&time_play=running",
      "time_kind=fixed&time_from_ms=0&time_to_ms=999999999999999&time_tz=UTC&time_play=fixed",
      "time_kind=calendar&time_value=made_up&time_tz=UTC&time_play=running",
      "time_kind=growing&time_value=0&time_tz=Not%2FAZone&time_play=running",
      "time_kind=fixed&time_from_ms=1&time_tz=UTC&time_play=fixed",
      "time_kind=fixed&time_origin=custom&time_from_ms=8639999999999700&time_to_ms=8640000000000300&time_tz=UTC&time_play=fixed",
      `time_kind=relative&time_value=${6 * HOUR}&time_tz=UTC&time_play=paused&time_from_ms=${nowMs - HOUR}&time_to_ms=${nowMs}`,
      `time_kind=calendar&time_value=previous_week&time_tz=UTC&time_play=paused&time_from_ms=${nowMs - 7 * 24 * HOUR}&time_to_ms=${nowMs}`,
    ]) {
      expect(decodeTimeRange(new URLSearchParams(query), config, nowMs), query).toBeNull();
    }
  });

  it("TR-URL-009 enforces configured bounds for calendar links", () => {
    const firstMinute = Date.parse("2026-09-01T00:01:00Z");
    expect(
      decodeTimeRange(
        new URLSearchParams("time_kind=calendar&time_value=today&time_tz=UTC&time_play=running"),
        config,
        firstMinute,
      ),
    ).toBeNull();
  });
});
