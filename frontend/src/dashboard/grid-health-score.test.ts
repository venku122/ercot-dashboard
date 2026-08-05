import { describe, expect, it } from "vitest";

import type { LatestPoint } from "./derived-metrics";
import { buildGridHealthScore, healthLatestQueries } from "./grid-health-score";
import type { Point } from "./types";

const now = 1_800_000_000;

function healthyInputs() {
  const latest = new Map<string, LatestPoint>([
    ["demand", { ts: now - 30, value: 70_000 }],
    ["capacity", { ts: now - 30, value: 90_000 }],
    ["frequency", { ts: now - 30, value: 60.001 }],
    ["price", { ts: now - 30, value: 45 }],
    ["health-eea", { ts: now - 30, value: 0 }],
    ["health-outages", { ts: now - 30, value: 4_000 }],
    ["health-weather-dfw", { ts: now - 1800, value: 34 }],
    ["health-weather-austin", { ts: now - 1800, value: 32 }],
    ["health-weather-houston", { ts: now - 1800, value: 33 }],
    ["health-weather-san-antonio", { ts: now - 1800, value: 35 }],
  ]);
  const context = new Map<string, Point[]>([
    [
      "derived:forecast-demand",
      [
        [now + 3600, 72_000],
        [now + 6 * 3600, 76_000],
      ],
    ],
  ]);
  return { context, latest, now };
}

describe("Grid Health Score", () => {
  it("defines the six additional latest inputs once", () => {
    expect(healthLatestQueries.map((query) => query.id)).toEqual([
      "health-eea",
      "health-outages",
      "health-weather-dfw",
      "health-weather-austin",
      "health-weather-houston",
      "health-weather-san-antonio",
    ]);
  });

  it("returns a bounded normal score with all eight factors", () => {
    const result = buildGridHealthScore(healthyInputs());
    expect(result).toMatchObject({
      coveragePercent: 100,
      label: "NORMAL",
      score: 100,
      status: "normal",
    });
    expect(result.factors).toHaveLength(8);
    expect(result.factors.reduce((total, entry) => total + entry.weight, 0)).toBe(100);
  });

  it("applies stress penalties without escaping the zero to 100 range", () => {
    const inputs = healthyInputs();
    inputs.latest.set("demand", { ts: now, value: 89_000 });
    inputs.latest.set("frequency", { ts: now, value: 59.82 });
    inputs.latest.set("price", { ts: now, value: 5_000 });
    inputs.latest.set("health-outages", { ts: now, value: 20_000 });
    inputs.latest.set("health-weather-dfw", { ts: now, value: 46 });
    inputs.context.set("derived:forecast-demand", [[now + 3600, 95_000]]);
    const result = buildGridHealthScore(inputs);
    expect(result.score).not.toBeNull();
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThan(50);
    expect(result).toMatchObject({ label: "CRITICAL", status: "critical" });
  });

  it("lets EEA state override the numeric status transparently", () => {
    const inputs = healthyInputs();
    inputs.latest.set("health-eea", { ts: now, value: 2 });
    expect(buildGridHealthScore(inputs)).toMatchObject({
      label: "STRAINED",
      score: 90,
      status: "strained",
    });
  });

  it("labels partial optional coverage and refuses missing core inputs", () => {
    const optionalMissing = healthyInputs();
    optionalMissing.latest.delete("health-outages");
    expect(buildGridHealthScore(optionalMissing)).toMatchObject({
      coveragePercent: 90,
      label: "LIMITED DATA",
      score: 100,
      status: "limited",
    });

    const coreMissing = healthyInputs();
    coreMissing.latest.set("frequency", { ts: now - 3600, value: 60 });
    expect(buildGridHealthScore(coreMissing)).toMatchObject({
      label: "SCORE UNAVAILABLE",
      score: null,
      status: "unavailable",
    });
  });
});
