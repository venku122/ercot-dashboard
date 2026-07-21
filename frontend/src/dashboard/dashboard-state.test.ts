import { describe, expect, it } from "vitest";

import { alignComparison, compareOffset, compareWindow } from "./compare";
import { freshnessState } from "./freshness";
import { seriesStats } from "./stats";
import {
  createTimeState,
  navigateWindow,
  resetLive,
  setCustomRange,
  tickLive,
  togglePause,
  zoomTo,
} from "./time-state";
import { dashboardStateFromUrl, dashboardStateToUrl } from "./url-state";
import { formatAge, formatValue } from "./units";

describe("global time state", () => {
  it("defaults live, pauses without moving, and resumes on the current clock", () => {
    const initial = createTimeState(10_000, 3600);
    expect(initial).toMatchObject({ mode: "live", start: 6400, end: 10_000 });
    const paused = togglePause(initial, 10_100);
    expect(paused.paused).toBe(true);
    expect(tickLive(paused, 20_000)).toEqual(paused);
    const resumed = togglePause(paused, 20_000);
    expect(resumed.paused).toBe(false);
    expect(tickLive(resumed, 20_030)).toMatchObject({ start: 16_430, end: 20_030 });
  });

  it("moves exactly one window and zoom transitions to fixed mode", () => {
    const initial = createTimeState(10_000, 1000);
    expect(navigateWindow(initial, -1)).toMatchObject({ start: 8000, end: 9000, mode: "fixed" });
    expect(zoomTo(initial, 9200, 9700)).toMatchObject({
      start: 9200,
      end: 9700,
      rangeSeconds: 500,
      mode: "fixed",
    });
    expect(resetLive(setCustomRange(1, 101), 500)).toMatchObject({
      start: 400,
      end: 500,
      mode: "live",
    });
  });
});

describe("shareable URL state", () => {
  it("round trips fixed time, comparison, events, inspect, legend and hidden series", () => {
    const parsed = dashboardStateFromUrl(
      new URL(
        "https://example.test/?live=0&from=100&to=700&range=600&compare=day&events=0&inspect=storage&legend=compact&hidden=storage:charging",
      ),
      1000,
    );
    expect(parsed.time.mode).toBe("fixed");
    expect(parsed.compare).toBe("day");
    expect(parsed.events).toBe(false);
    expect(parsed.expandedChart).toBe("storage");
    expect(parsed.hiddenSeries.has("storage:charging")).toBe(true);
    const output = dashboardStateToUrl(parsed, new URL("https://example.test/"));
    expect(output.searchParams.get("from")).toBe("100");
    expect(output.searchParams.get("hidden")).toBe("storage:charging");
  });
});

describe("comparison alignment", () => {
  const time = { mode: "fixed", paused: false, start: 1000, end: 1600, rangeSeconds: 600 } as const;

  it("resolves prior period, day and week offsets", () => {
    expect(compareOffset("previous_period", time)).toBe(600);
    expect(compareOffset("day", time)).toBe(86400);
    expect(compareOffset("week", time)).toBe(604800);
    expect(compareOffset("custom", time, 172800)).toBe(172800);
    expect(compareWindow("previous_period", time)).toEqual({ start: 400, end: 1000, offset: 600 });
    expect(alignComparison([[400, 12]], 600)).toEqual([[1000, 12]]);
  });

  it("round trips a custom comparison offset", () => {
    const parsed = dashboardStateFromUrl(
      new URL("https://example.test/?compare=custom&compare_offset=172800"),
      1000,
    );
    expect(parsed.customCompareSeconds).toBe(172800);
    expect(
      dashboardStateToUrl(parsed, new URL("https://example.test/")).searchParams.get(
        "compare_offset",
      ),
    ).toBe("172800");
  });
});

describe("statistics, freshness, and units", () => {
  it("computes visible-window legend statistics", () => {
    expect(
      seriesStats([
        [1, -10],
        [2, 20],
        [3, 5],
      ]),
    ).toEqual({ latest: 5, minimum: -10, maximum: 20, average: 5, sum: 15 });
  });

  it("classifies freshness and formats operational values", () => {
    expect(freshnessState(300, 300)).toBe("fresh");
    expect(freshnessState(700, 300)).toBe("delayed");
    expect(freshnessState(1300, 300)).toBe("stale");
    expect(formatValue(-1234.5, "$/MWh")).toContain("-1,234.5");
    expect(formatAge(3700)).toBe("1h old");
  });
});
