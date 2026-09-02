import { describe, expect, it } from "vitest";

import {
  createCalendarRange,
  createFixedRange,
  createRelativeRange,
  pauseTimeRange,
} from "../time-range";
import {
  ERCOT_TIME_RANGE_CONFIG,
  legacyTimeRangeFromUrl,
  toErcotTimeState,
  writeLegacyTimeRangeProjection,
} from "./time-range-adapter";

const HOUR_MS = 3_600_000;
const NOW_MS = Date.parse("2026-09-01T18:00:00Z");

describe("ERCOT time range adapter", () => {
  it("TR-DOM-015 converts explicit core milliseconds to ERCOT API seconds once", () => {
    expect(
      toErcotTimeState(createRelativeRange(6 * HOUR_MS, "past-6-hours", "America/Chicago"), NOW_MS),
    ).toEqual({
      end: NOW_MS / 1000,
      mode: "live",
      paused: false,
      rangeSeconds: 6 * 3600,
      start: NOW_MS / 1000 - 6 * 3600,
    });
    expect(
      toErcotTimeState(createFixedRange(NOW_MS - HOUR_MS, NOW_MS, "zoom"), NOW_MS + HOUR_MS),
    ).toEqual({
      end: NOW_MS / 1000,
      mode: "fixed",
      paused: false,
      rangeSeconds: 3600,
      start: NOW_MS / 1000 - 3600,
    });
  });

  it("TR-URL-006 parses bounded legacy live, fixed, and paused links", () => {
    expect(legacyTimeRangeFromUrl(new URLSearchParams("range=21600&live=1"), NOW_MS)).toEqual(
      createRelativeRange(6 * HOUR_MS, "past-6-hours", "America/Chicago"),
    );
    expect(
      legacyTimeRangeFromUrl(new URLSearchParams("range=3600&live=0&from=100&to=3700"), NOW_MS)
        ?.selection,
    ).toEqual({ fromMs: 100_000, kind: "fixed", origin: "custom", toMs: 3_700_000 });
    const paused = legacyTimeRangeFromUrl(
      new URLSearchParams("range=21600&live=1&paused=1"),
      NOW_MS,
    );
    expect(paused?.playback.kind).toBe("paused");
    expect(paused && toErcotTimeState(paused, NOW_MS + HOUR_MS).end).toBe(NOW_MS / 1000);
  });

  it("TR-URL-009 rejects unsafe legacy windows", () => {
    for (const query of [
      "range=-1&live=1",
      "range=999999999&live=1",
      "range=3600&live=0&from=NaN&to=3700",
      "range=3600&live=0&from=3700&to=100",
      "range=3600&live=0&from=0&to=999999999999",
    ]) {
      expect(legacyTimeRangeFromUrl(new URLSearchParams(query), NOW_MS), query).toBeNull();
    }
  });

  it("TR-URL-007 writes a safe legacy projection for compatible states", () => {
    const params = writeLegacyTimeRangeProjection(
      createRelativeRange(HOUR_MS, "past-hour", "America/Chicago"),
      new URLSearchParams("view=market"),
      NOW_MS,
    );
    expect(params.toString()).toContain("view=market");
    expect(params.get("range")).toBe("3600");
    expect(params.get("live")).toBe("1");
    const calendar = writeLegacyTimeRangeProjection(
      createCalendarRange("today", "America/Chicago"),
      new URLSearchParams(),
      NOW_MS,
    );
    expect(calendar.get("live")).toBe("0");
    expect(calendar.get("from")).not.toBeNull();
    expect(calendar.get("to")).not.toBeNull();
  });

  it("preserves paused endpoints in the seconds adapter", () => {
    const live = createRelativeRange(HOUR_MS, "past-hour", "America/Chicago");
    const paused = pauseTimeRange(live, NOW_MS, ERCOT_TIME_RANGE_CONFIG);
    expect(toErcotTimeState(paused, NOW_MS + HOUR_MS)).toMatchObject({
      end: NOW_MS / 1000,
      mode: "fixed",
      paused: true,
      start: NOW_MS / 1000 - 3600,
    });
  });
});
