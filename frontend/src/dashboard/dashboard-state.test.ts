import { describe, expect, it } from "vitest";

import { canonicalChunkUrl, liveQuerySince, mergePoints } from "./api";
import { alignComparison, alignComparisonForMode, compareOffset, compareWindow } from "./compare";
import { freshnessState } from "./freshness";
import { seriesStats } from "./stats";
import { formatChicagoDateTimeInput, parseChicagoDateTime } from "./zoned-time";
import {
  dashboardStateFromUrl,
  dashboardStateToUrl,
  dashboardViewFromUrl,
  dashboardViewToUrl,
} from "./url-state";
import { formatAge, formatValue } from "./units";

describe("shareable URL state", () => {
  it("normalizes and serializes the active progressive-disclosure view", () => {
    expect(dashboardViewFromUrl(new URL("https://example.test/?view=weather"))).toBe("weather");
    expect(dashboardViewFromUrl(new URL("https://example.test/?view=outlook"))).toBe("outlook");
    expect(dashboardViewFromUrl(new URL("https://example.test/?view=external-context"))).toBe(
      "external-context",
    );
    expect(dashboardViewFromUrl(new URL("https://example.test/?view=unknown"))).toBe("overview");
    const output = dashboardViewToUrl("diagnostics", new URL("https://example.test/?range=3600"));
    expect(output.searchParams.get("view")).toBe("diagnostics");
    expect(output.searchParams.get("range")).toBe("3600");
    const external = dashboardViewToUrl(
      "external-context",
      new URL("https://example.test/?grid_resource=gis&context_source=epa_egrid"),
    );
    expect(external.searchParams.get("grid_resource")).toBeNull();
    expect(external.searchParams.get("context_source")).toBe("epa_egrid");
    expect(dashboardViewToUrl("overview", external).searchParams.get("context_source")).toBeNull();
  });

  it("round trips fixed time, comparison, events, inspect, legend and hidden series", () => {
    const parsed = dashboardStateFromUrl(
      new URL(
        "https://example.test/?live=0&from=100&to=700&range=600&compare=day&events=0&history=1&inspect=storage&legend=compact&hidden=storage:charging",
      ),
      1000,
    );
    expect(parsed.time.selection.kind).toBe("fixed");
    expect(parsed.compare).toBe("day");
    expect(parsed.events).toBe(false);
    expect(parsed.history).toBe(true);
    expect(parsed.expandedChart).toBe("storage");
    expect(parsed.hiddenSeries.has("storage:charging")).toBe(true);
    const output = dashboardStateToUrl(parsed, new URL("https://example.test/"));
    expect(output.searchParams.get("from")).toBe("100");
    expect(output.searchParams.get("hidden")).toBe("storage:charging");
    expect(output.searchParams.get("history")).toBe("1");
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

  it("uses America/Chicago calendar arithmetic across DST transitions", () => {
    const springCurrent = Date.parse("2026-03-09T12:00:00-05:00") / 1000;
    const springPrevious = Date.parse("2026-03-08T12:00:00-05:00") / 1000;
    const fallCurrent = Date.parse("2026-11-02T12:00:00-06:00") / 1000;
    const fallPrevious = Date.parse("2026-11-01T12:00:00-06:00") / 1000;

    expect(
      alignComparisonForMode([[springPrevious, 1]], "day", springCurrent - springPrevious),
    ).toEqual([[springCurrent, 1]]);
    expect(alignComparisonForMode([[fallPrevious, 1]], "day", fallCurrent - fallPrevious)).toEqual([
      [fallCurrent, 1],
    ]);
  });

  it("parses and formats custom ranges in America/Chicago regardless of browser timezone", () => {
    expect(parseChicagoDateTime("2026-07-21T18:30")).toBe(
      Date.parse("2026-07-21T18:30:00-05:00") / 1000,
    );
    expect(formatChicagoDateTimeInput(Date.parse("2026-07-21T23:30:00Z") / 1000)).toBe(
      "2026-07-21T18:30",
    );
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
    expect(formatValue(-1234.5, "$/MWh")).toBe("-$1,234.50/MWh");
    expect(formatAge(3700)).toBe("1h old");
  });
});

describe("live request planning", () => {
  it("serializes equivalent historical chunk tags to one canonical GET URL", () => {
    const base = {
      chunkSeconds: 86400 as const,
      end: 172800,
      metric: "ercot.pricing",
      resolution: 300,
      start: 86400,
    };
    expect(canonicalChunkUrl({ ...base, tags: ["zone:b", "zone:a"] })).toBe(
      canonicalChunkUrl({ ...base, tags: ["zone:a", "zone:b", "zone:a"] }),
    );
  });

  it("fetches only the unseen tail and timestamp-dedupes the rolling window", () => {
    const time = { mode: "live", paused: false, start: 100, end: 400, rangeSeconds: 300 } as const;
    const previous: Array<[number, number]> = [
      [100, 1],
      [200, 2],
      [300, 3],
    ];

    expect(liveQuerySince(time, previous)).toBe(301);
    expect(
      mergePoints(
        previous,
        [
          [300, 30],
          [400, 4],
        ],
        150,
        400,
      ),
    ).toEqual([
      [200, 2],
      [300, 30],
      [400, 4],
    ]);
  });
});
